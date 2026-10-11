// The Microsoft source-code annotations DirectXMath and DirectXCollision use, as nothing: DirectXMath
// includes "sal.h", which only the Windows SDK has. Its README asks non-Windows builds to provide
// one; this is on core/directx_collision.cpp's include path on Android only (see CMakeLists.txt).

#pragma once

#define _Analysis_assume_(expr)
#define _In_
#define _In_reads_(size)
#define _In_reads_bytes_(size)
#define _Out_
#define _Out_opt_
#define _Out_writes_(size)
#define _Out_writes_bytes_(size)
#define _Success_(expr)
#define _Use_decl_annotations_
