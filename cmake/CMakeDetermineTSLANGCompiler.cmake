# Release of tslang to install into tools/ when the compiler is not found
set(TSLANG_VERSION "v0.0-pre-alpha92" CACHE STRING "tslang release (tag of github.com/ASDAlexander77/TypeScriptCompiler) to download")
set(TSLANG_INSTALL_DIR "${CMAKE_SOURCE_DIR}/tools/tslang" CACHE PATH "Where the downloaded tslang is installed")
set(TSLANG_LINUX_DISTRO "ubuntu-24.04" CACHE STRING "Linux build of tslang to download: ubuntu-22.04, ubuntu-24.04 or ubuntu-26.04")

# Locate your custom compiler
find_program(CMAKE_TSLANG_COMPILER
    NAMES tslang tslang.exe
    HINTS "${TSLANG_INSTALL_DIR}" "I:\\tslang" "${CMAKE_SOURCE_DIR}/tools"
    DOC "TSLANG compiler")

if (NOT CMAKE_TSLANG_COMPILER)
    if (CMAKE_HOST_WIN32)
        set(_tslang_asset "tslang-${TSLANG_VERSION}-windows-x64.zip")
    elseif (CMAKE_HOST_UNIX AND NOT CMAKE_HOST_APPLE)
        set(_tslang_asset "tslang-${TSLANG_VERSION}-${TSLANG_LINUX_DISTRO}-x64.tar.gz")
    else()
        message(FATAL_ERROR "No tslang release for this host: set CMAKE_TSLANG_COMPILER")
    endif()

    set(_tslang_url "https://github.com/ASDAlexander77/TypeScriptCompiler/releases/download/${TSLANG_VERSION}/${_tslang_asset}")
    set(_tslang_archive "${CMAKE_BINARY_DIR}/${_tslang_asset}")

    message(STATUS "tslang not found, downloading ${_tslang_url}")
    file(DOWNLOAD "${_tslang_url}" "${_tslang_archive}" STATUS _tslang_status SHOW_PROGRESS TLS_VERIFY ON)
    list(GET _tslang_status 0 _tslang_code)
    if (NOT _tslang_code EQUAL 0)
        file(REMOVE "${_tslang_archive}")
        message(FATAL_ERROR "Failed to download ${_tslang_url}: ${_tslang_status}")
    endif()

    file(MAKE_DIRECTORY "${TSLANG_INSTALL_DIR}")
    file(ARCHIVE_EXTRACT INPUT "${_tslang_archive}" DESTINATION "${TSLANG_INSTALL_DIR}")
    file(REMOVE "${_tslang_archive}")

    # the cached NOTFOUND must be cleared for the search to run again
    unset(CMAKE_TSLANG_COMPILER CACHE)
    find_program(CMAKE_TSLANG_COMPILER
        NAMES tslang tslang.exe
        HINTS "${TSLANG_INSTALL_DIR}"
        NO_DEFAULT_PATH
        DOC "TSLANG compiler")
    if (NOT CMAKE_TSLANG_COMPILER)
        message(FATAL_ERROR "tslang was not found in ${TSLANG_INSTALL_DIR} after extracting ${_tslang_asset}")
    endif()
endif()

cmake_path(GET CMAKE_TSLANG_COMPILER PARENT_PATH CMAKE_TSLANG_DIR)

mark_as_advanced(CMAKE_TSLANG_COMPILER)
mark_as_advanced(CMAKE_TSLANG_DIR)

# Which source extensions belong to TSLANG, and the object suffix
set(CMAKE_TSLANG_SOURCE_FILE_EXTENSIONS ts)
if (NOT WIN32)
	set(CMAKE_TSLANG_OUTPUT_EXTENSION .o)
else()
	set(CMAKE_TSLANG_OUTPUT_EXTENSION .obj)   # .o on Linux
endif()
set(CMAKE_TSLANG_COMPILER_ENV_VAR "TSLANG")

# Emit the compiler-id config file CMake expects
configure_file(
    ${CMAKE_CURRENT_LIST_DIR}/CMakeTSLANGCompiler.cmake.in
    ${CMAKE_PLATFORM_INFO_DIR}/CMakeTSLANGCompiler.cmake @ONLY)
