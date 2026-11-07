/// <reference path="../donut_handles.d.ts" />
// Video decoding into textures (core/video_player.cpp)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class VideoPlayerHandle { private readonly __videoPlayer: index; }

// The Xbox ATG VideoTexturePC12 sample's MediaEnginePlayer (core/video_player.cpp, linked only into
// the examples that list it; Windows): Media Foundation's Media Engine playing a video file (path
// relative to the executable's directory) on a D3D11 device of the adapter with this LUID
// (Donut_GetAdapterLuid; 0, 0: any), muted or not, playing as soon as it can. Null (after printing
// why) on failure; free it with Donut_DestroyVideoPlayer.
@nodrops declare function Donut_CreateVideoPlayer(path: string, luidLow: int, luidHigh: int, muted: int): VideoPlayerHandle | null;
@nodrops declare function Donut_GetVideoWidth(videoPlayer: VideoPlayerHandle): int;
@nodrops declare function Donut_GetVideoHeight(videoPlayer: VideoPlayerHandle): int;
// Non-zero once it played to its end.
@nodrops declare function Donut_IsVideoFinished(videoPlayer: VideoPlayerHandle): int;
// The current frame, if there is a new one, into a shared texture (Donut_GetSharedTextureHandle),
// as the sample's TransferFrame; 1 if it drew one.
@nodrops declare function Donut_TransferVideoFrame(videoPlayer: VideoPlayerHandle, sharedHandle: Opaque): int;
// The same into memory, for APIs that can't share textures with D3D11 (Vulkan): BGRA8 rows
// (Donut_GetVideoFrameData, rowPitch bytes apart), valid until the next transfer.
@nodrops declare function Donut_TransferVideoFrameToMemory(videoPlayer: VideoPlayerHandle): int;
@nodrops declare function Donut_GetVideoFrameData(videoPlayer: VideoPlayerHandle): Opaque;
@nodrops declare function Donut_GetVideoFrameRowPitch(videoPlayer: VideoPlayerHandle): int;
// Moves playback to `seconds` into the video.
@nodrops declare function Donut_SetVideoTime(videoPlayer: VideoPlayerHandle, seconds: number): void;
@nodrops declare function Donut_DestroyVideoPlayer(videoPlayer: VideoPlayerHandle): void;
