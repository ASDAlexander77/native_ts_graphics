# Run as a POST_BUILD step of donut_interop_shared (cmake -P):
#   -DDLL=<donut_interop.dll> -DDEF=<out .def> -DLIB=<out import .lib> -DDUMPBIN=<dumpbin.exe> -DLIBEXE=<lib.exe>
# Writes an import library holding only the DLL's Donut_* exports, for tslang --jit-native: the DLL is
# built with WINDOWS_EXPORT_ALL_SYMBOLS, so its own import library also exports the CRT inlines it
# compiled (sprintf_s, ...), which clash with TypeScriptAsyncRuntime.lib's when lld-link links them.
foreach(var DLL DEF LIB DUMPBIN LIBEXE)
    if (NOT DEFINED ${var})
        message(FATAL_ERROR "make_jit_import_lib.cmake: -D${var}=... is required")
    endif()
endforeach()

execute_process(
    COMMAND "${DUMPBIN}" /NOLOGO /EXPORTS "${DLL}"
    OUTPUT_VARIABLE exports
    RESULT_VARIABLE result)
if (NOT result EQUAL 0)
    message(FATAL_ERROR "make_jit_import_lib.cmake: dumpbin /EXPORTS ${DLL} failed")
endif()

# dumpbin lines: "<ordinal> <hint> <RVA> <name>".
string(REGEX MATCHALL "\n +[0-9]+ +[0-9A-F]+ +[0-9A-F]+ +Donut_[A-Za-z0-9_]+" lines "${exports}")
set(names "")
foreach(line IN LISTS lines)
    string(REGEX MATCH "Donut_[A-Za-z0-9_]+$" name "${line}")
    string(APPEND names "    ${name}\n")
endforeach()
list(LENGTH lines count)
if (count EQUAL 0)
    message(FATAL_ERROR "make_jit_import_lib.cmake: ${DLL} exports no Donut_* function")
endif()

get_filename_component(dll_name "${DLL}" NAME)
file(WRITE "${DEF}" "LIBRARY ${dll_name}\nEXPORTS\n${names}")
execute_process(
    COMMAND "${LIBEXE}" /NOLOGO /MACHINE:X64 "/DEF:${DEF}" "/OUT:${LIB}"
    RESULT_VARIABLE result)
if (NOT result EQUAL 0)
    message(FATAL_ERROR "make_jit_import_lib.cmake: lib /DEF:${DEF} failed")
endif()
