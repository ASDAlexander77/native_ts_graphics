# cmake -DPATCH=<file> [-DREPOSITORY=<folder>] -P apply_patch.cmake: applies the patch to the git
# repository in REPOSITORY (relative to the current directory, which is the default), unless it is
# applied already. NRIFramework's patch step (core/nri/CMakeLists.txt), which runs again when the
# declaration changes, so applying has to be idempotent, as the main CMakeLists.txt's apply_patches.
if (NOT REPOSITORY)
    set(REPOSITORY ".")
endif()
find_package(Git REQUIRED)

execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --check "${PATCH}"
    WORKING_DIRECTORY "${REPOSITORY}"
    RESULT_VARIABLE check
    OUTPUT_QUIET ERROR_QUIET)
if (check EQUAL 0)
    message(STATUS "Applying ${PATCH}")
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply "${PATCH}"
        WORKING_DIRECTORY "${REPOSITORY}"
        RESULT_VARIABLE apply)
    if (NOT apply EQUAL 0)
        message(FATAL_ERROR "Failed to apply ${PATCH}")
    endif()
    return()
endif()

execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --check --reverse "${PATCH}"
    WORKING_DIRECTORY "${REPOSITORY}"
    RESULT_VARIABLE reverseCheck
    OUTPUT_QUIET ERROR_QUIET)
if (NOT reverseCheck EQUAL 0)
    message(FATAL_ERROR "${PATCH} does not apply to ${REPOSITORY}")
endif()
