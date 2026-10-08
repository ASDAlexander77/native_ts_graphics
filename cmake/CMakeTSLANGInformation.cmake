# The actual compile command.
# Placeholders CMake substitutes:
#   <CMAKE_TSLANG_COMPILER>  the binary
#   <FLAGS>               per-target flags
#   <SOURCE>              input .ts
#   <OBJECT>              output .obj
#   <DEFINES> <INCLUDES>  optional
if(NOT CMAKE_TSLANG_COMPILE_OBJECT)
    set(CMAKE_TSLANG_COMPILE_OBJECT
        "<CMAKE_TSLANG_COMPILER> <FLAGS> --default-lib-path=${CMAKE_TSLANG_DIR} --emit=obj -o=<OBJECT> <SOURCE>")
endif()

# tslang has no option to write a depfile of the files a .ts imports and references, so Ninja's
# rule names a DEP_FILE that is never made (a missing one counts as empty) and the imports are
# listed by hand as OBJECT_DEPENDS (CMakeLists.txt). Once it has one, pass it here, e.g.
#   set(CMAKE_DEPFILE_FLAGS_TSLANG "--dep-file=<DEP_FILE>")
#   set(CMAKE_TSLANG_DEPFILE_FORMAT gcc)

# How CMake links TSLANG objects into an executable/library.
# Reuse the C++ linker so linking with .cpp works out of the box.
if(NOT CMAKE_CXX_COMPILER_LOADED)
    message(FATAL_ERROR "TSLANG links through the C++ toolchain: enable CXX before TSLANG, e.g. project(<name> CXX TSLANG)")
endif()
if(NOT CMAKE_TSLANG_LINK_EXECUTABLE)
    # <FLAGS> holds tslang compile flags, which the C++ driver does not understand.
    set(CMAKE_TSLANG_LINK_EXECUTABLE
        "<CMAKE_CXX_COMPILER> <LINK_FLAGS> <OBJECTS> -o <TARGET> <LINK_LIBRARIES>")
endif()

set(CMAKE_TSLANG_INFORMATION_LOADED 1)
