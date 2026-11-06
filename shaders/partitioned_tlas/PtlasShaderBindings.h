//*********************************************************
//
// Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// This code is licensed under the MIT License (MIT).
// THIS CODE IS PROVIDED *AS IS* WITHOUT WARRANTY OF
// ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING ANY
// IMPLIED WARRANTIES OF FITNESS FOR A PARTICULAR
// PURPOSE, MERCHANTABILITY, OR NON-INFRINGEMENT.
//
//*********************************************************

// examples/partitioned_tlas.ts's copy: the HLSL half only (ShaderMake's include scanner follows the
// C++ half's includes; its static_asserts hold for the sample's D3D12 structures). Changes: the
// instance write's partition index is at byte 92 on Vulkan
// (VkPartitionedAccelerationStructureWriteInstanceDataNV); the write operation is core/ptlas.cpp's,
// after its 8-byte operation count, so its ArgCount is at byte 12.

#pragma once

// ByteAddressBuffer access to the DXR instance and indirect-operation ABI.
// Keep the native D3D12 structures on the CPU; verify every shader offset here.
#define PTLAS_UINT uint

static const PTLAS_UINT RegularInstanceStride = 64;
static const PTLAS_UINT PtlasWriteInstanceStride = 104;
#ifdef SPIRV
static const PTLAS_UINT PtlasPartitionIndexOffset = 92;
#else
static const PTLAS_UINT PtlasPartitionIndexOffset = 76;
#endif
static const PTLAS_UINT PtlasOperationArgCountOffset = 12;
static const PTLAS_UINT PtlasGlobalPartition = 0xffffffffu;

#undef PTLAS_UINT
