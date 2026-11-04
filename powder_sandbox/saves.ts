/// <reference path="../core/nri/nri_interop.d.ts" />
import {
    CAPACITY, GRID_CAPACITY, F_BODY, MAX_BODIES, BODY_FLOATS, F_TPRE, CARRIED_FLOAT_SECTIONS,
    REGRID_GRID, REGRID_PARTICLES, B_ALL, GRAVITY_DOWN, GRAVITY_TILT, STATE_BUFFERS, UNDO_DEPTH,
    SAVE_PATH, SAVE_MAGIC, SAVE_VERSION, SAVE_HEADER_INTS, SAVE_HEADER_INTS_3
} from "./defs";
import { SandboxLevels } from "./levels";

// The state's GPU work: undo snapshots, saving and loading, the grid remade (a phone turned, or a
// -regrid test) and the -roundTrip test, requested by a frame and recorded into it.
export class SandboxSaves extends SandboxLevels {
    // Copies the state (STATE_BUFFERS' buffers, one after another) into snapshot, or out of it back
    // into them; snapshot is in snapshotState before and after (a readback buffer: CopyDestination).
    recordStateCopy(commandBuffer: NriCommandBufferHandle, snapshot: NriBufferHandle, toSnapshot: boolean, snapshotState: NriBufferState) {
        const liveState = toSnapshot ? NriBufferState.CopySource : NriBufferState.CopyDestination;
        const snapshotUse = toSnapshot ? NriBufferState.CopyDestination : NriBufferState.CopySource;
        if (snapshotState != snapshotUse) {
            Nri_CmdBufferBarrier(commandBuffer, snapshot, snapshotState, snapshotUse);
        }
        let offset = 0;
        for (const i of STATE_BUFFERS) {
            const buffer = this.buffers[i];
            const size = this.bufferSizes[i];
            Nri_CmdBufferBarrier(commandBuffer, buffer, NriBufferState.Storage, liveState);
            if (toSnapshot) {
                Nri_CmdCopyBufferRegion(commandBuffer, snapshot, offset, buffer, 0, size);
            } else {
                Nri_CmdCopyBufferRegion(commandBuffer, buffer, 0, snapshot, offset, size);
            }
            Nri_CmdBufferBarrier(commandBuffer, buffer, liveState, NriBufferState.Storage);
            offset += size;
        }
        if (snapshotState != snapshotUse) {
            Nri_CmdBufferBarrier(commandBuffer, snapshot, snapshotUse, snapshotState);
        }
    }

    // Before the frame's constants: the grid's size an undo or a load will leave it at. An undo
    // takes its snapshot's (even if the window has turned since: it's shown with margins rather
    // than remade, which would lose what the undo brought back); a load its save's, or, if the
    // save is the other way around from the window, the window's (and is remade to it).
    prepareStateRequests() {
        if (this.undoRequested && this.undoCount > 0) {
            this.setGrid(this.undoW[this.undoTop], this.undoH[this.undoTop]);
        }
        if (this.loadRequested) {
            this.loadRequested = false;
            const loadBuffer = this.openSave();
            if (loadBuffer) {
                this.loadBuffer = loadBuffer;
                this.loadPending = true;
                const wide = this.width >= this.height - this.toolbarHeight;
                if (wide == (this.loadW >= this.loadH)) {
                    this.setGrid(this.loadW, this.loadH);
                } else {
                    this.fitGrid();
                    this.layout();
                }
            }
        }
    }

    // The frame's requests, before it simulates: undo (the newest snapshot back), load (the save
    // file's state, after a snapshot of the current one), a regrid (the grid remade at
    // gridW x gridH, after a snapshot), a snapshot (a stroke or Clear begins), a save (the state
    // read back, written once the frame is done).
    recordStateRequests(commandBuffer: NriCommandBufferHandle) {
        let snapshotTaken = false;
        if (this.undoRequested) {
            this.undoRequested = false;
            if (this.undoCount > 0) {
                this.recordStateCopy(commandBuffer, this.undoBuffers[this.undoTop], false, NriBufferState.CopyDestination);
                this.stateW = this.undoW[this.undoTop];
                this.stateH = this.undoH[this.undoTop];
                this.undoTop = (this.undoTop + UNDO_DEPTH - 1) % UNDO_DEPTH;
                this.undoCount--;
                // The restored state stands as it was: no scene strokes or Clear still to come.
                this.script = [];
                this.needsInit = false;
                this.snapshotRequested = false;
            } else {
                this.showMessage("Nothing to undo");
            }
        }
        const loadBuffer = this.loadBuffer;
        if (this.loadPending) {
            this.loadPending = false;
            if (loadBuffer) {
                this.pushSnapshot(commandBuffer);
                snapshotTaken = true;
                this.recordStateCopy(commandBuffer, loadBuffer, false, NriBufferState.CopySource);
                this.stateW = this.loadW;
                this.stateH = this.loadH;
                this.script = [];
                this.needsInit = false;
                this.snapshotRequested = false;
                this.showMessage("Loaded");
            }
        }
        if (this.stateW != this.gridW || this.stateH != this.gridH) {
            if (!snapshotTaken) {
                this.pushSnapshot(commandBuffer);
            }
            this.recordRegrid(commandBuffer);
        }
        if (this.snapshotRequested) {
            this.snapshotRequested = false;
            this.pushSnapshot(commandBuffer);
        }
        if (this.saveRequested) {
            this.saveRequested = false;
            const device = this.device;
            if (device) {
                const saveReadback = Nri_CreateReadbackBuffer(device, this.stateSize);
                if (saveReadback) {
                    this.recordStateCopy(commandBuffer, saveReadback, true, NriBufferState.CopyDestination);
                    this.saveReadback = saveReadback;
                } else {
                    this.showMessage("Cannot save: out of memory");
                }
            }
        }
    }

    // The state into the next undo slot (over the oldest once they're all used).
    pushSnapshot(commandBuffer: NriCommandBufferHandle) {
        this.undoTop = (this.undoTop + 1) % UNDO_DEPTH;
        this.undoCount = Math.min(this.undoCount + 1, UNDO_DEPTH);
        this.undoW[this.undoTop] = this.stateW;
        this.undoH[this.undoTop] = this.stateH;
        this.recordStateCopy(commandBuffer, this.undoBuffers[this.undoTop], true, NriBufferState.CopyDestination);
    }

    // The grid the buffers hold (stateW x stateH) remade at gridW x gridH: its cells and cell
    // temperatures copied aside into the int sections (which every step remakes), then
    // regrid_grid_cs and regrid_particles_cs move them, the old grid's floor on the new one's and
    // centered across it.
    recordRegrid(commandBuffer: NriCommandBufferHandle) {
        const oldW = this.stateW;
        const oldH = this.stateH;
        const oldStride = (oldW + 1) * (oldH + 1);
        const scratch = this.buffers[1];
        const gridFloat = this.buffers[2];
        const cells = this.buffers[3];
        Nri_CmdBufferBarrier(commandBuffer, scratch, NriBufferState.Storage, NriBufferState.CopyDestination);
        Nri_CmdBufferBarrier(commandBuffer, gridFloat, NriBufferState.Storage, NriBufferState.CopySource);
        Nri_CmdBufferBarrier(commandBuffer, cells, NriBufferState.Storage, NriBufferState.CopySource);
        Nri_CmdCopyBufferRegion(commandBuffer, scratch, 0, cells, 0, oldW * oldH * 4);
        Nri_CmdCopyBufferRegion(commandBuffer, scratch, oldStride * 4, gridFloat, F_TPRE * oldStride * 4,
            CARRIED_FLOAT_SECTIONS * oldStride * 4);
        // (then the bodies, which regrid_grid_cs moves by the offset)
        Nri_CmdCopyBufferRegion(commandBuffer, scratch, (1 + CARRIED_FLOAT_SECTIONS) * oldStride * 4, gridFloat,
            F_BODY * oldStride * 4, MAX_BODIES * BODY_FLOATS * 4);
        Nri_CmdBufferBarrier(commandBuffer, scratch, NriBufferState.CopyDestination, NriBufferState.Storage);
        Nri_CmdBufferBarrier(commandBuffer, gridFloat, NriBufferState.CopySource, NriBufferState.Storage);
        Nri_CmdBufferBarrier(commandBuffer, cells, NriBufferState.CopySource, NriBufferState.Storage);

        const computeLayout = this.computeLayout;
        if (!computeLayout) {
            return;
        }
        Nri_CmdSetDescriptorPool(commandBuffer, this.descriptorPool);
        Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
        // (the brush's fields stand for the old grid and the offset)
        this.kernels.setInt(8, oldW);
        this.kernels.setInt(9, oldH);
        this.kernels.setInt(15, this.regridOffsetX(oldW));
        this.kernels.setInt(16, this.gridH - oldH);
        this.kernels.dispatch(commandBuffer, REGRID_GRID, this.stride, B_ALL);
        this.kernels.dispatch(commandBuffer, REGRID_PARTICLES, CAPACITY, B_ALL);
        this.kernels.setInt(8, this.tool);
        this.kernels.setInt(15, this.emitType);
        this.stateW = this.gridW;
        this.stateH = this.gridH;
        console.log(`Grid remade: ${oldW} x ${oldH} to ${this.gridW} x ${this.gridH} cells`);
    }

    // The save file's state in a buffer to copy from (CopySource) and its grid's size (loadW,
    // loadH), or null (with a message) when there's none, or it's from another version.
    openSave(): NriBufferHandle | null {
        const device = this.device;
        if (!device) {
            return null;
        }
        const file = Nri_LoadFile(SAVE_PATH);
        if (!file) {
            this.showMessage("Nothing saved yet");
            return null;
        }
        const bytes: int[] = [];
        for (let i = 0; i < SAVE_HEADER_INTS * 4; i++) {
            bytes.push(0);
        }
        Nri_CopyFileBytes(file, 0, Math.min(bytes.length, Nri_GetFileSize(file)), Ref(bytes[0]));
        const header: int[] = [];
        for (let i = 0; i < SAVE_HEADER_INTS; i++) {
            header.push(bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24));
        }
        const headerInts = header[1] == 3 ? SAVE_HEADER_INTS_3 : SAVE_HEADER_INTS;
        let loadBuffer: NriBufferHandle | null = null;
        if (header[0] != SAVE_MAGIC || (header[1] != SAVE_VERSION && header[1] != 3) || header[4] != CAPACITY
            || Nri_GetFileSize(file) != headerInts * 4 + this.stateSize
            || header[2] < 3 || header[3] < 3 || (header[2] + 1) * (header[3] + 1) > GRID_CAPACITY) {
            this.showMessage("The save is from another version");
        } else {
            this.loadW = header[2];
            this.loadH = header[3];
            this.gravityMode = header[1] == 3 ? GRAVITY_DOWN : Math.min(Math.max(header[5], 0), GRAVITY_TILT);
            this.gravityX = header[1] == 3 ? -1.0 : header[6] / 256.0;
            this.gravityY = header[1] == 3 ? -1.0 : header[7] / 256.0;
            loadBuffer = Nri_CreateStorageBufferFromFile(device, this.queue, file, headerInts * 4, this.stateSize, 4,
                NriBufferState.CopySource);
            if (!loadBuffer) {
                this.showMessage("Cannot load: out of memory");
            }
        }
        Nri_DestroyFile(file);
        return loadBuffer;
    }

    // After the frame's submission: the save written (once the GPU has read the state back), the
    // load's buffer freed.
    finishStateRequests() {
        const device = this.device;
        const saveReadback = this.saveReadback;
        const loadBuffer = this.loadBuffer;
        if (!device) {
            return;
        }
        if (saveReadback || loadBuffer) {
            Nri_DeviceWaitIdle(device);
        }
        if (saveReadback) {
            const header: int[] = [SAVE_MAGIC, SAVE_VERSION, this.gridW, this.gridH, CAPACITY, this.gravityMode,
                Math.round(this.gravityPointX() * 256.0), Math.round(this.gravityPointY() * 256.0)];
            const saved = Nri_SaveBufferToFile(saveReadback, this.stateSize, Ref(header[0]), SAVE_HEADER_INTS, SAVE_PATH) != 0;
            this.showMessage(saved ? "Saved" : "Cannot save");
            Nri_DestroyBuffer(saveReadback);
            this.saveReadback = null;
        }
        if (loadBuffer) {
            Nri_DestroyBuffer(loadBuffer);
            this.loadBuffer = null;
        }
    }

    // -roundTrip: halfway, the state cleared (without the scene's strokes) and undone; then saved,
    // cleared and loaded. If either restore failed the U-tube would end empty.
    roundTripRequests(frameIndex: int) {
        const half: int = Math.floor(this.testFrames / 2);
        if (frameIndex == half) {
            this.sceneOnClear = false;
            this.snapshotRequested = true;
            this.needsInit = true;
        } else if (frameIndex == half + 1) {
            this.undoRequested = true;
        } else if (frameIndex == half + 100) {
            this.saveRequested = true;
        } else if (frameIndex == half + 101) {
            this.needsInit = true;
        } else if (frameIndex == half + 102) {
            this.loadRequested = true;
        }
    }

    // -regrid 1: halfway, the grid remade 20 cells taller (on its floor, so the water stays where it
    // is), then back; 2: turned, its width and height swapped (the U-tube cropped at its sides
    // and its divider still in the middle).
    regridRequests(frameIndex: int) {
        const half: int = Math.floor(this.testFrames / 2);
        const oldW = this.gridW;
        const oldH = this.gridH;
        if (frameIndex == half) {
            this.regridCount = CAPACITY - this.probe[0];
            if (this.regrid == 1) {
                this.setGrid(oldW, oldH + 20);
            } else {
                this.setGrid(oldH, oldW);
            }
            this.reshaped(oldW, oldH);
        } else if (frameIndex == half + 100 && this.regrid == 1) {
            this.setGrid(oldW, oldH - 20);
            this.reshaped(oldW, oldH);
        }
    }
}
