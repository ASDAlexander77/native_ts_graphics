# powder_sandbox_nri, included by the top-level CMakeLists.txt (paths are from the repository's root).
#
# A falling-sand sandbox (an original example, NRI only): FLIP liquids and sand with an
# incompressible pressure solve, rising gases, uranium's neutrons, temperature everywhere, painted
# with the mouse or a finger. Its test pours water into one side of a U-tube and checks both sides
# level out. D3D12 and Vulkan only (root descriptors and atomics on structured buffers): no DXBC.
donut_compile_shaders(
    TARGET powder_sandbox_shaders
    PROJECT_NAME "Powder Sandbox"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/powder_sandbox/shaders/powder_sandbox.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/powder_sandbox/shaders/powder_sandbox.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/powder_sandbox/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/powder_sandbox/spirv
)
# Its media (the levels) is copied to the binaries' media/powder_sandbox/, with the shared media.
add_custom_command(TARGET copy_media POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E ${MEDIA_COPY_COMMAND} "${CMAKE_CURRENT_SOURCE_DIR}/powder_sandbox/media"
        "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/powder_sandbox")
add_tslang_nri_example(powder_sandbox_nri SOURCE powder_sandbox/powder_sandbox_nri.ts SHADERS powder_sandbox_shaders
    core/text_format.ts core/json_reader.ts core/nri_compute_kernels.ts core/nri_frame_ring.ts
    core/nri_gpu_profiler.ts core/ui/nri_slider.ts core/ui/nri_tab_row.ts core/ui/nri_icons.ts core/nri_swap_chain.ts
    core/int_file.ts core/nri_gpu_timer.ts core/fixed_step.ts core/frame_rate.ts core/pan_zoom.ts
    core/auto_quality.ts core/sound_events.ts core/pointer_gestures.ts
    powder_sandbox/defs.ts powder_sandbox/state.ts powder_sandbox/view.ts powder_sandbox/levels.ts
    powder_sandbox/saves.ts powder_sandbox/simulation.ts powder_sandbox/ui.ts powder_sandbox/sandbox.ts
    powder_sandbox/checks.ts
    MEDIA powder_sandbox)
add_tslang_example_test(powder_sandbox_nri)
# The materials' showcase: oil on water, a sand pile, burning wood, uranium in a pool, an emitter.
add_tslang_example_test(powder_sandbox_nri SUFFIX showcase ARGS -scene 2 -testFrames 600)
# Lava poured into a pool and next to wood: it sets to stone, and the pool's ice block melts.
add_tslang_example_test(powder_sandbox_nri SUFFIX lava ARGS -scene 3 -testFrames 900)
# The newer materials: heat goes further along a metal bar than a stone one; acid eats the wood in a
# glass tub and leaves the glass; salt poured into a tank dissolves, and the salt water sinks.
add_tslang_example_test(powder_sandbox_nri SUFFIX materials ARGS -scene 4 -testFrames 900)
# Gunpowder under sand next to a pool, lit: it goes off, throws the sand, and its glass wall holds.
add_tslang_example_test(powder_sandbox_nri SUFFIX gunpowder ARGS -scene 5 -testFrames 600)
# Water and honey let go side by side: the honey (viscous) stays higher and runs half as far.
add_tslang_example_test(powder_sandbox_nri SUFFIX viscosity ARGS -scene 6 -testFrames 120)
# A film of water on the floor: surface tension pulls it into beads.
add_tslang_example_test(powder_sandbox_nri SUFFIX tension ARGS -scene 7 -testFrames 180)
# A fan blowing across falling sand: the wind carries the grains to the right.
add_tslang_example_test(powder_sandbox_nri SUFFIX wind ARGS -scene 8 -testFrames 180)
# Rigid bodies: a block dropped into a pool floats at its surface, one half over a ledge tips off.
add_tslang_example_test(powder_sandbox_nri SUFFIX bodies ARGS -scene 9 -testFrames 300)
# A level from its file (powder_sandbox/media/scenes/test_fill.json): an emitter fills a cup, the
# level's goal.
add_tslang_example_test(powder_sandbox_nri SUFFIX level ARGS -sceneFile test_fill -testFrames 600)
# The challenges (index.json's levels): each one's solution, painted a second in, reaches its goal
# for 3 stars; untouched, it isn't reached. Light the lamp solved at 4 and 7 s earns 2 stars and 1.
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_lamp ARGS -sceneFile lamp -solve 1 -testStars 3 -testFrames 300)
add_tslang_example_test(powder_sandbox_nri SUFFIX unsolved_lamp ARGS -sceneFile lamp -testStars 0 -testFrames 300)
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_cup ARGS -sceneFile cup -solve 1 -testStars 3 -testFrames 480)
add_tslang_example_test(powder_sandbox_nri SUFFIX unsolved_cup ARGS -sceneFile cup -testStars 0 -testFrames 480)
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_garden ARGS -sceneFile garden -solve 1 -testStars 3 -testFrames 480)
add_tslang_example_test(powder_sandbox_nri SUFFIX unsolved_garden ARGS -sceneFile garden -testStars 0 -testFrames 480)
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_logs ARGS -sceneFile logs -solve 1 -testStars 3 -testFrames 720)
add_tslang_example_test(powder_sandbox_nri SUFFIX unsolved_logs ARGS -sceneFile logs -testStars 0 -testFrames 720)
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_hole ARGS -sceneFile hole -solve 1 -testStars 3 -testFrames 360)
add_tslang_example_test(powder_sandbox_nri SUFFIX unsolved_hole ARGS -sceneFile hole -testStars 0 -testFrames 360)
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_dry ARGS -sceneFile dry -solve 1 -testStars 3 -testFrames 900)
add_tslang_example_test(powder_sandbox_nri SUFFIX unsolved_dry ARGS -sceneFile dry -testStars 0 -testFrames 900)
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_melt ARGS -sceneFile melt -solve 1 -testStars 3 -testFrames 1080)
add_tslang_example_test(powder_sandbox_nri SUFFIX unsolved_melt ARGS -sceneFile melt -testStars 0 -testFrames 1080)
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_stone ARGS -sceneFile stone -solve 1 -testStars 3 -testFrames 480)
add_tslang_example_test(powder_sandbox_nri SUFFIX unsolved_stone ARGS -sceneFile stone -testStars 0 -testFrames 480)
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_lamp_late ARGS -sceneFile lamp -solve 4 -testStars 2 -testFrames 480)
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_lamp_later ARGS -sceneFile lamp -solve 7 -testStars 1 -testFrames 600)
# In a window held upright (a phone's shape), a level's grid is still wider than tall: the challenges
# laid out on it are solved as they are in a wide one.
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_dry_upright ARGS -sceneFile dry -solve 1 -testStars 3 -window 540 1170 -testFrames 900)
# At the S23's shape held sideways (a 278 x 144 grid): the dry cup's water, falling from its emitter, used to reach the cup within a second there.
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_dry_s23 ARGS -sceneFile dry -solve 1 -testStars 3 -window 1280 751 -testFrames 900)
add_tslang_example_test(powder_sandbox_nri SUFFIX challenge_stone_upright ARGS -sceneFile stone -solve 1 -testStars 3 -window 540 1170 -testFrames 480)
# Acid diluted by water (and warming it); oil and petrol lit: the petrol burns away, the oil slowly.
add_tslang_example_test(powder_sandbox_nri SUFFIX acid ARGS -scene 10 -testFrames 900)
add_tslang_example_test(powder_sandbox_nri SUFFIX burning ARGS -scene 11 -testFrames 900)
# A fire's plume drives the air, its smoke spreads under a ceiling; water and sand with no gravity
# stay put, and gather round an attraction point.
add_tslang_example_test(powder_sandbox_nri SUFFIX gases ARGS -scene 12 -testFrames 300)
add_tslang_example_test(powder_sandbox_nri SUFFIX weightless ARGS -scene 13 -testFrames 300 -gravity off)
add_tslang_example_test(powder_sandbox_nri SUFFIX attractor ARGS -scene 13 -testFrames 600 -gravity point)
# Tilted to the right (the phone's gravity sensor's direction, set): they fall that way.
add_tslang_example_test(powder_sandbox_nri SUFFIX tilted ARGS -scene 13 -testFrames 180 -gravity tilt -tilt 1 0)
# Batteries, wires and lamps (one beyond salt water, one beyond fresh); gunpowder on a live wire.
add_tslang_example_test(powder_sandbox_nri SUFFIX circuits ARGS -scene 14 -testFrames 300)
# Electrolysis of salt water, lit neon; hydrogen burning, fuses; thermite on a metal plate;
# nitroglycerin dropped; C-4 sparked; coal and wood burning.
add_tslang_example_test(powder_sandbox_nri SUFFIX electrolysis ARGS -scene 15 -testFrames 300)
add_tslang_example_test(powder_sandbox_nri SUFFIX combustion ARGS -scene 16 -testFrames 300)
add_tslang_example_test(powder_sandbox_nri SUFFIX thermite ARGS -scene 17 -testFrames 600)
add_tslang_example_test(powder_sandbox_nri SUFFIX nitroglycerin ARGS -scene 18 -testFrames 300)
add_tslang_example_test(powder_sandbox_nri SUFFIX c4 ARGS -scene 19 -testFrames 300)
add_tslang_example_test(powder_sandbox_nri SUFFIX coal ARGS -scene 20 -testFrames 300)
# A clone, black and white holes, a sponge and seeds, switches, detectors and heaters.
add_tslang_example_test(powder_sandbox_nri SUFFIX clone ARGS -scene 21 -testFrames 300)
add_tslang_example_test(powder_sandbox_nri SUFFIX holes ARGS -scene 22 -testFrames 300)
add_tslang_example_test(powder_sandbox_nri SUFFIX plants ARGS -scene 23 -testFrames 300)
add_tslang_example_test(powder_sandbox_nri SUFFIX switches ARGS -scene 24 -testFrames 300)
# Auto quality, its budget set below any GPU's step time: the grid is made smaller.
add_tslang_example_test(powder_sandbox_nri SUFFIX quality ARGS -scene 2 -testFrames 300 -stepBudget 0.01)
# -profile (core/nri_gpu_profiler.ts): the showcase's dispatches timed, reported at least once.
add_tslang_example_test(powder_sandbox_nri SUFFIX profile ARGS -scene 2 -testFrames 600 -profile)
# The U-tube, cleared and undone halfway, then saved, cleared and loaded: it must still level out.
add_tslang_example_test(powder_sandbox_nri SUFFIX roundtrip ARGS -utube -roundTrip)
# The U-tube's grid remade halfway (a phone turned): 20 cells taller and back, losing nothing; and
# turned (its width and height swapped), cropped at its sides (or, started upright on a phone, its
# water slumping to half its height). It must still level out.
add_tslang_example_test(powder_sandbox_nri SUFFIX regrid ARGS -utube -regrid 1)
add_tslang_example_test(powder_sandbox_nri SUFFIX turned ARGS -utube -regrid 2 -testFrames 3600)

# The store build (Google Play): `cmake --build --preset android-arm64 --target powder_sandbox_nri_release`
# makes bin/powder_sandbox_nri-release.apk and .aab, signed with the release keystore (see
# powder_sandbox/store/README.md). Its window hides the system bars (TSLANG_ANDROID_IMMERSIVE): an
# app targeting Android 15+ is drawn under them, which would put the toolbar under the gesture bar.
if (ANDROID AND TARGET powder_sandbox_nri_app)
    target_compile_definitions(powder_sandbox_nri_app PRIVATE TSLANG_ANDROID_IMMERSIVE=1)
endif()
add_tslang_android_release(powder_sandbox_nri
    PACKAGE io.github.asdalexander77.powdersandbox
    LABEL "Powder Sandbox"
    VERSION_CODE 3
    VERSION_NAME 0.2
    RES powder_sandbox/android/res
    ICON @mipmap/ic_launcher
    CATEGORY game
    VULKAN_VERSION 0x403000
    TARGET_SDK 36)
