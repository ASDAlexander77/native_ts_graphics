# cmake [-DREPOSITORY=<folder>] -P reset_checkout.cmake: puts the git repository in REPOSITORY (relative
# to the current directory, which is the default) back to its checked-out files. NRIFramework's patch
# step (core/nri/CMakeLists.txt) runs it first, so its patches always apply to clean files: when the
# step runs again (the declaration changed, a patch was added), an earlier patch whose lines a later
# one changed couldn't be recognized as applied.
if (NOT REPOSITORY)
    set(REPOSITORY ".")
endif()
find_package(Git REQUIRED)

execute_process(
    COMMAND "${GIT_EXECUTABLE}" checkout -- .
    WORKING_DIRECTORY "${REPOSITORY}"
    RESULT_VARIABLE result)
if (NOT result EQUAL 0)
    message(FATAL_ERROR "Failed to reset ${REPOSITORY}")
endif()
