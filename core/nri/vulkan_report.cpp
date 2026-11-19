// ReportVulkanDevice: what the Vulkan driver has, on the standard output (logcat on Android), for a
// device NRI couldn't make: Nri_CreateDevice calls it when nriCreateDevice fails on Vulkan. NRI
// stops at the first thing it lacks ('timelineSemaphore' on Google Play Games on PC's Vulkan 1.1),
// so this says everything else such a driver lacks, which decides whether a fallback is worth
// writing: the API version, the device extensions, the ones promoted to Vulkan 1.2 and 1.3 it hasn't,
// the features it says false, its subgroup operations, queues and compute limits.
//
// Android only (its loader, libvulkan.so, opened here, and the NDK's Vulkan headers); elsewhere
// nothing (vulkaninfo says it there).

#if defined(__ANDROID__)

#include <vulkan/vulkan.h>

#include <dlfcn.h>

#include <algorithm>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <iterator>
#include <string>
#include <vector>

namespace
{
    // The VkBool32 members of a feature struct, by name and offset
    struct Field
    {
        const char* name;
        size_t offset;
    };

#define F(type, member) { #member, offsetof(type, member) }

    const Field kFeatures10[] = {
        F(VkPhysicalDeviceFeatures, robustBufferAccess), F(VkPhysicalDeviceFeatures, fullDrawIndexUint32),
        F(VkPhysicalDeviceFeatures, imageCubeArray), F(VkPhysicalDeviceFeatures, independentBlend),
        F(VkPhysicalDeviceFeatures, geometryShader), F(VkPhysicalDeviceFeatures, tessellationShader),
        F(VkPhysicalDeviceFeatures, sampleRateShading), F(VkPhysicalDeviceFeatures, dualSrcBlend),
        F(VkPhysicalDeviceFeatures, logicOp), F(VkPhysicalDeviceFeatures, multiDrawIndirect),
        F(VkPhysicalDeviceFeatures, drawIndirectFirstInstance), F(VkPhysicalDeviceFeatures, depthClamp),
        F(VkPhysicalDeviceFeatures, depthBiasClamp), F(VkPhysicalDeviceFeatures, fillModeNonSolid),
        F(VkPhysicalDeviceFeatures, depthBounds), F(VkPhysicalDeviceFeatures, wideLines),
        F(VkPhysicalDeviceFeatures, largePoints), F(VkPhysicalDeviceFeatures, alphaToOne),
        F(VkPhysicalDeviceFeatures, multiViewport), F(VkPhysicalDeviceFeatures, samplerAnisotropy),
        F(VkPhysicalDeviceFeatures, textureCompressionETC2), F(VkPhysicalDeviceFeatures, textureCompressionASTC_LDR),
        F(VkPhysicalDeviceFeatures, textureCompressionBC), F(VkPhysicalDeviceFeatures, occlusionQueryPrecise),
        F(VkPhysicalDeviceFeatures, pipelineStatisticsQuery), F(VkPhysicalDeviceFeatures, vertexPipelineStoresAndAtomics),
        F(VkPhysicalDeviceFeatures, fragmentStoresAndAtomics), F(VkPhysicalDeviceFeatures, shaderTessellationAndGeometryPointSize),
        F(VkPhysicalDeviceFeatures, shaderImageGatherExtended), F(VkPhysicalDeviceFeatures, shaderStorageImageExtendedFormats),
        F(VkPhysicalDeviceFeatures, shaderStorageImageMultisample), F(VkPhysicalDeviceFeatures, shaderStorageImageReadWithoutFormat),
        F(VkPhysicalDeviceFeatures, shaderStorageImageWriteWithoutFormat), F(VkPhysicalDeviceFeatures, shaderUniformBufferArrayDynamicIndexing),
        F(VkPhysicalDeviceFeatures, shaderSampledImageArrayDynamicIndexing), F(VkPhysicalDeviceFeatures, shaderStorageBufferArrayDynamicIndexing),
        F(VkPhysicalDeviceFeatures, shaderStorageImageArrayDynamicIndexing), F(VkPhysicalDeviceFeatures, shaderClipDistance),
        F(VkPhysicalDeviceFeatures, shaderCullDistance), F(VkPhysicalDeviceFeatures, shaderFloat64),
        F(VkPhysicalDeviceFeatures, shaderInt64), F(VkPhysicalDeviceFeatures, shaderInt16),
        F(VkPhysicalDeviceFeatures, shaderResourceResidency), F(VkPhysicalDeviceFeatures, shaderResourceMinLod),
        F(VkPhysicalDeviceFeatures, sparseBinding), F(VkPhysicalDeviceFeatures, sparseResidencyBuffer),
        F(VkPhysicalDeviceFeatures, sparseResidencyImage2D), F(VkPhysicalDeviceFeatures, sparseResidencyImage3D),
        F(VkPhysicalDeviceFeatures, sparseResidency2Samples), F(VkPhysicalDeviceFeatures, sparseResidency4Samples),
        F(VkPhysicalDeviceFeatures, sparseResidency8Samples), F(VkPhysicalDeviceFeatures, sparseResidency16Samples),
        F(VkPhysicalDeviceFeatures, sparseResidencyAliased), F(VkPhysicalDeviceFeatures, variableMultisampleRate),
        F(VkPhysicalDeviceFeatures, inheritedQueries),
    };

    const Field kFeatures11[] = {
        F(VkPhysicalDeviceVulkan11Features, storageBuffer16BitAccess), F(VkPhysicalDeviceVulkan11Features, uniformAndStorageBuffer16BitAccess),
        F(VkPhysicalDeviceVulkan11Features, storagePushConstant16), F(VkPhysicalDeviceVulkan11Features, storageInputOutput16),
        F(VkPhysicalDeviceVulkan11Features, multiview), F(VkPhysicalDeviceVulkan11Features, multiviewGeometryShader),
        F(VkPhysicalDeviceVulkan11Features, multiviewTessellationShader), F(VkPhysicalDeviceVulkan11Features, variablePointersStorageBuffer),
        F(VkPhysicalDeviceVulkan11Features, variablePointers), F(VkPhysicalDeviceVulkan11Features, protectedMemory),
        F(VkPhysicalDeviceVulkan11Features, samplerYcbcrConversion), F(VkPhysicalDeviceVulkan11Features, shaderDrawParameters),
    };

    const Field kFeatures12[] = {
        F(VkPhysicalDeviceVulkan12Features, samplerMirrorClampToEdge), F(VkPhysicalDeviceVulkan12Features, drawIndirectCount),
        F(VkPhysicalDeviceVulkan12Features, storageBuffer8BitAccess), F(VkPhysicalDeviceVulkan12Features, uniformAndStorageBuffer8BitAccess),
        F(VkPhysicalDeviceVulkan12Features, storagePushConstant8), F(VkPhysicalDeviceVulkan12Features, shaderBufferInt64Atomics),
        F(VkPhysicalDeviceVulkan12Features, shaderSharedInt64Atomics), F(VkPhysicalDeviceVulkan12Features, shaderFloat16),
        F(VkPhysicalDeviceVulkan12Features, shaderInt8), F(VkPhysicalDeviceVulkan12Features, descriptorIndexing),
        F(VkPhysicalDeviceVulkan12Features, shaderInputAttachmentArrayDynamicIndexing),
        F(VkPhysicalDeviceVulkan12Features, shaderUniformTexelBufferArrayDynamicIndexing),
        F(VkPhysicalDeviceVulkan12Features, shaderStorageTexelBufferArrayDynamicIndexing),
        F(VkPhysicalDeviceVulkan12Features, shaderUniformBufferArrayNonUniformIndexing),
        F(VkPhysicalDeviceVulkan12Features, shaderSampledImageArrayNonUniformIndexing),
        F(VkPhysicalDeviceVulkan12Features, shaderStorageBufferArrayNonUniformIndexing),
        F(VkPhysicalDeviceVulkan12Features, shaderStorageImageArrayNonUniformIndexing),
        F(VkPhysicalDeviceVulkan12Features, shaderInputAttachmentArrayNonUniformIndexing),
        F(VkPhysicalDeviceVulkan12Features, shaderUniformTexelBufferArrayNonUniformIndexing),
        F(VkPhysicalDeviceVulkan12Features, shaderStorageTexelBufferArrayNonUniformIndexing),
        F(VkPhysicalDeviceVulkan12Features, descriptorBindingUniformBufferUpdateAfterBind),
        F(VkPhysicalDeviceVulkan12Features, descriptorBindingSampledImageUpdateAfterBind),
        F(VkPhysicalDeviceVulkan12Features, descriptorBindingStorageImageUpdateAfterBind),
        F(VkPhysicalDeviceVulkan12Features, descriptorBindingStorageBufferUpdateAfterBind),
        F(VkPhysicalDeviceVulkan12Features, descriptorBindingUniformTexelBufferUpdateAfterBind),
        F(VkPhysicalDeviceVulkan12Features, descriptorBindingStorageTexelBufferUpdateAfterBind),
        F(VkPhysicalDeviceVulkan12Features, descriptorBindingUpdateUnusedWhilePending),
        F(VkPhysicalDeviceVulkan12Features, descriptorBindingPartiallyBound),
        F(VkPhysicalDeviceVulkan12Features, descriptorBindingVariableDescriptorCount),
        F(VkPhysicalDeviceVulkan12Features, runtimeDescriptorArray), F(VkPhysicalDeviceVulkan12Features, samplerFilterMinmax),
        F(VkPhysicalDeviceVulkan12Features, scalarBlockLayout), F(VkPhysicalDeviceVulkan12Features, imagelessFramebuffer),
        F(VkPhysicalDeviceVulkan12Features, uniformBufferStandardLayout), F(VkPhysicalDeviceVulkan12Features, shaderSubgroupExtendedTypes),
        F(VkPhysicalDeviceVulkan12Features, separateDepthStencilLayouts), F(VkPhysicalDeviceVulkan12Features, hostQueryReset),
        F(VkPhysicalDeviceVulkan12Features, timelineSemaphore), F(VkPhysicalDeviceVulkan12Features, bufferDeviceAddress),
        F(VkPhysicalDeviceVulkan12Features, bufferDeviceAddressCaptureReplay), F(VkPhysicalDeviceVulkan12Features, bufferDeviceAddressMultiDevice),
        F(VkPhysicalDeviceVulkan12Features, vulkanMemoryModel), F(VkPhysicalDeviceVulkan12Features, vulkanMemoryModelDeviceScope),
        F(VkPhysicalDeviceVulkan12Features, vulkanMemoryModelAvailabilityVisibilityChains),
        F(VkPhysicalDeviceVulkan12Features, shaderOutputViewportIndex), F(VkPhysicalDeviceVulkan12Features, shaderOutputLayer),
        F(VkPhysicalDeviceVulkan12Features, subgroupBroadcastDynamicId),
    };

    const Field kFeatures13[] = {
        F(VkPhysicalDeviceVulkan13Features, robustImageAccess), F(VkPhysicalDeviceVulkan13Features, inlineUniformBlock),
        F(VkPhysicalDeviceVulkan13Features, descriptorBindingInlineUniformBlockUpdateAfterBind),
        F(VkPhysicalDeviceVulkan13Features, pipelineCreationCacheControl), F(VkPhysicalDeviceVulkan13Features, privateData),
        F(VkPhysicalDeviceVulkan13Features, shaderDemoteToHelperInvocation), F(VkPhysicalDeviceVulkan13Features, shaderTerminateInvocation),
        F(VkPhysicalDeviceVulkan13Features, subgroupSizeControl), F(VkPhysicalDeviceVulkan13Features, computeFullSubgroups),
        F(VkPhysicalDeviceVulkan13Features, synchronization2), F(VkPhysicalDeviceVulkan13Features, textureCompressionASTC_HDR),
        F(VkPhysicalDeviceVulkan13Features, shaderZeroInitializeWorkgroupMemory), F(VkPhysicalDeviceVulkan13Features, dynamicRendering),
        F(VkPhysicalDeviceVulkan13Features, shaderIntegerDotProduct), F(VkPhysicalDeviceVulkan13Features, maintenance4),
    };

    // A Vulkan 1.1 driver: the 1.1 features from their own structs (core in 1.1), and the 1.2 and 1.3
    // ones NRI's Vulkan 1.1 path takes from extensions (patches/NRI-vulkan-1.1.patch), where the
    // driver has the extension.
    const Field kStorage16[] = {
        F(VkPhysicalDevice16BitStorageFeatures, storageBuffer16BitAccess), F(VkPhysicalDevice16BitStorageFeatures, uniformAndStorageBuffer16BitAccess),
        F(VkPhysicalDevice16BitStorageFeatures, storagePushConstant16), F(VkPhysicalDevice16BitStorageFeatures, storageInputOutput16),
    };
    const Field kShaderDrawParameters[] = { F(VkPhysicalDeviceShaderDrawParametersFeatures, shaderDrawParameters) };
    const Field kTimeline[] = { F(VkPhysicalDeviceTimelineSemaphoreFeatures, timelineSemaphore) };
    const Field kDescriptorIndexing[] = {
        F(VkPhysicalDeviceDescriptorIndexingFeatures, shaderSampledImageArrayNonUniformIndexing),
        F(VkPhysicalDeviceDescriptorIndexingFeatures, shaderStorageBufferArrayNonUniformIndexing),
        F(VkPhysicalDeviceDescriptorIndexingFeatures, shaderStorageImageArrayNonUniformIndexing),
        F(VkPhysicalDeviceDescriptorIndexingFeatures, descriptorBindingSampledImageUpdateAfterBind),
        F(VkPhysicalDeviceDescriptorIndexingFeatures, descriptorBindingStorageImageUpdateAfterBind),
        F(VkPhysicalDeviceDescriptorIndexingFeatures, descriptorBindingStorageBufferUpdateAfterBind),
        F(VkPhysicalDeviceDescriptorIndexingFeatures, descriptorBindingPartiallyBound),
        F(VkPhysicalDeviceDescriptorIndexingFeatures, descriptorBindingVariableDescriptorCount),
        F(VkPhysicalDeviceDescriptorIndexingFeatures, runtimeDescriptorArray),
    };
    const Field kBufferDeviceAddress[] = { F(VkPhysicalDeviceBufferDeviceAddressFeatures, bufferDeviceAddress) };
    const Field kStorage8[] = {
        F(VkPhysicalDevice8BitStorageFeatures, storageBuffer8BitAccess), F(VkPhysicalDevice8BitStorageFeatures, uniformAndStorageBuffer8BitAccess),
        F(VkPhysicalDevice8BitStorageFeatures, storagePushConstant8),
    };
    const Field kFloat16Int8[] = { F(VkPhysicalDeviceShaderFloat16Int8Features, shaderFloat16), F(VkPhysicalDeviceShaderFloat16Int8Features, shaderInt8) };
    const Field kScalarBlockLayout[] = { F(VkPhysicalDeviceScalarBlockLayoutFeatures, scalarBlockLayout) };
    const Field kHostQueryReset[] = { F(VkPhysicalDeviceHostQueryResetFeatures, hostQueryReset) };
    const Field kMemoryModel[] = {
        F(VkPhysicalDeviceVulkanMemoryModelFeatures, vulkanMemoryModel), F(VkPhysicalDeviceVulkanMemoryModelFeatures, vulkanMemoryModelDeviceScope),
    };
    const Field kSynchronization2[] = { F(VkPhysicalDeviceSynchronization2Features, synchronization2) };
    const Field kDynamicRendering[] = { F(VkPhysicalDeviceDynamicRenderingFeatures, dynamicRendering) };
    const Field kExtendedDynamicState[] = { F(VkPhysicalDeviceExtendedDynamicStateFeaturesEXT, extendedDynamicState) };
    const Field kMaintenance4[] = { F(VkPhysicalDeviceMaintenance4Features, maintenance4) };
    const Field kDemoteToHelper[] = { F(VkPhysicalDeviceShaderDemoteToHelperInvocationFeatures, shaderDemoteToHelperInvocation) };
    const Field kSubgroupSizeControl[] = {
        F(VkPhysicalDeviceSubgroupSizeControlFeatures, subgroupSizeControl), F(VkPhysicalDeviceSubgroupSizeControlFeatures, computeFullSubgroups),
    };

#undef F

    // The extensions promoted to Vulkan 1.2 and 1.3: a driver below that version may have them as
    // extensions (as NRI's Vulkan 1.1 path takes them).
    const char* const kPromoted12[] = {
        "VK_KHR_8bit_storage", "VK_KHR_buffer_device_address", "VK_KHR_create_renderpass2", "VK_KHR_depth_stencil_resolve",
        "VK_KHR_draw_indirect_count", "VK_KHR_driver_properties", "VK_KHR_image_format_list", "VK_KHR_imageless_framebuffer",
        "VK_KHR_sampler_mirror_clamp_to_edge", "VK_KHR_separate_depth_stencil_layouts", "VK_KHR_shader_atomic_int64",
        "VK_KHR_shader_float16_int8", "VK_KHR_shader_float_controls", "VK_KHR_shader_subgroup_extended_types",
        "VK_KHR_spirv_1_4", "VK_KHR_timeline_semaphore", "VK_KHR_uniform_buffer_standard_layout", "VK_KHR_vulkan_memory_model",
        "VK_EXT_descriptor_indexing", "VK_EXT_host_query_reset", "VK_EXT_sampler_filter_minmax", "VK_EXT_scalar_block_layout",
        "VK_EXT_separate_stencil_usage", "VK_EXT_shader_viewport_index_layer",
    };
    const char* const kPromoted13[] = {
        "VK_KHR_copy_commands2", "VK_KHR_dynamic_rendering", "VK_KHR_format_feature_flags2", "VK_KHR_maintenance4",
        "VK_KHR_shader_integer_dot_product", "VK_KHR_shader_non_semantic_info", "VK_KHR_shader_terminate_invocation",
        "VK_KHR_synchronization2", "VK_KHR_zero_initialize_workgroup_memory", "VK_EXT_4444_formats",
        "VK_EXT_extended_dynamic_state", "VK_EXT_extended_dynamic_state2", "VK_EXT_image_robustness",
        "VK_EXT_inline_uniform_block", "VK_EXT_pipeline_creation_cache_control", "VK_EXT_pipeline_creation_feedback",
        "VK_EXT_private_data", "VK_EXT_shader_demote_to_helper_invocation", "VK_EXT_subgroup_size_control",
        "VK_EXT_texel_buffer_alignment", "VK_EXT_texture_compression_astc_hdr", "VK_EXT_tooling_info", "VK_EXT_ycbcr_2plane_444_formats",
    };

    // Words on lines of at most ~160 characters, each starting with prefix (logcat's lines are kept
    // short, and the Play Games log takes them whole).
    void PrintWords(const char* prefix, const std::vector<std::string>& words)
    {
        std::string line = prefix;
        const size_t prefixLength = line.size();
        for (const std::string& word : words)
        {
            if (line.size() > prefixLength && line.size() + 1 + word.size() > 160)
            {
                printf("%s\n", line.c_str());
                line = prefix;
            }
            line += ' ';
            line += word;
        }
        if (words.empty())
            line += " (none)";
        printf("%s\n", line.c_str());
    }

    // The struct's features the driver says false
    void PrintMissing(const char* structName, const void* features, const Field* fields, size_t fieldNum)
    {
        std::vector<std::string> missing;
        for (size_t i = 0; i < fieldNum; i++)
        {
            VkBool32 value = VK_FALSE;
            memcpy(&value, (const char*)features + fields[i].offset, sizeof(value));
            if (!value)
                missing.push_back(fields[i].name);
        }
        const std::string prefix = std::string("Vulkan report:   ") + structName + " false:";
        if (missing.empty())
            printf("Vulkan report:   %s: all %zu true\n", structName, fieldNum);
        else
            PrintWords(prefix.c_str(), missing);
    }

    std::string Version(uint32_t version)
    {
        return std::to_string(VK_API_VERSION_MAJOR(version)) + "." + std::to_string(VK_API_VERSION_MINOR(version)) + "."
            + std::to_string(VK_API_VERSION_PATCH(version));
    }

    std::string QueueFlags(VkQueueFlags flags)
    {
        std::string text;
        if (flags & VK_QUEUE_GRAPHICS_BIT)
            text += "graphics ";
        if (flags & VK_QUEUE_COMPUTE_BIT)
            text += "compute ";
        if (flags & VK_QUEUE_TRANSFER_BIT)
            text += "transfer ";
        if (flags & VK_QUEUE_SPARSE_BINDING_BIT)
            text += "sparse ";
        if (flags & VK_QUEUE_PROTECTED_BIT)
            text += "protected ";
        if (!text.empty())
            text.pop_back();
        return text;
    }

    std::string SubgroupOperations(VkSubgroupFeatureFlags flags)
    {
        static const struct
        {
            VkSubgroupFeatureFlagBits bit;
            const char* name;
        } kOperations[] = {
            { VK_SUBGROUP_FEATURE_BASIC_BIT, "basic" }, { VK_SUBGROUP_FEATURE_VOTE_BIT, "vote" },
            { VK_SUBGROUP_FEATURE_ARITHMETIC_BIT, "arithmetic" }, { VK_SUBGROUP_FEATURE_BALLOT_BIT, "ballot" },
            { VK_SUBGROUP_FEATURE_SHUFFLE_BIT, "shuffle" }, { VK_SUBGROUP_FEATURE_SHUFFLE_RELATIVE_BIT, "shuffle_relative" },
            { VK_SUBGROUP_FEATURE_CLUSTERED_BIT, "clustered" }, { VK_SUBGROUP_FEATURE_QUAD_BIT, "quad" },
        };
        std::string text;
        for (const auto& operation : kOperations)
        {
            if (flags & operation.bit)
                text += std::string(operation.name) + " ";
        }
        if (!text.empty())
            text.pop_back();
        return text;
    }

    struct Loader
    {
        PFN_vkGetInstanceProcAddr getInstanceProcAddr = nullptr;
        VkInstance instance = VK_NULL_HANDLE;

        template <typename T>
        T Get(const char* name) const
        {
            return reinterpret_cast<T>(getInstanceProcAddr(instance, name));
        }
    };

    void ReportPhysicalDevice(const Loader& vk, VkPhysicalDevice physicalDevice, uint32_t index, bool instance11)
    {
        auto getProperties = vk.Get<PFN_vkGetPhysicalDeviceProperties>("vkGetPhysicalDeviceProperties");
        auto getFeatures = vk.Get<PFN_vkGetPhysicalDeviceFeatures>("vkGetPhysicalDeviceFeatures");
        auto enumerateExtensions = vk.Get<PFN_vkEnumerateDeviceExtensionProperties>("vkEnumerateDeviceExtensionProperties");
        auto getQueueFamilies = vk.Get<PFN_vkGetPhysicalDeviceQueueFamilyProperties>("vkGetPhysicalDeviceQueueFamilyProperties");
        auto getFeatures2 = instance11 ? vk.Get<PFN_vkGetPhysicalDeviceFeatures2>("vkGetPhysicalDeviceFeatures2") : nullptr;
        auto getProperties2 = instance11 ? vk.Get<PFN_vkGetPhysicalDeviceProperties2>("vkGetPhysicalDeviceProperties2") : nullptr;
        if (!getProperties || !getFeatures || !enumerateExtensions || !getQueueFamilies)
            return;

        VkPhysicalDeviceProperties properties = {};
        getProperties(physicalDevice, &properties);
        printf("Vulkan report: device %u: %s, Vulkan %s, driver version 0x%x, vendor 0x%04x, device 0x%04x, type %d\n", index,
            properties.deviceName, Version(properties.apiVersion).c_str(), properties.driverVersion, properties.vendorID,
            properties.deviceID, (int)properties.deviceType);

        uint32_t extensionNum = 0;
        enumerateExtensions(physicalDevice, nullptr, &extensionNum, nullptr);
        std::vector<VkExtensionProperties> extensions(extensionNum);
        enumerateExtensions(physicalDevice, nullptr, &extensionNum, extensions.data());
        extensions.resize(extensionNum);
        std::vector<std::string> extensionNames;
        for (const VkExtensionProperties& extension : extensions)
            extensionNames.push_back(extension.extensionName);
        std::sort(extensionNames.begin(), extensionNames.end());
        auto has = [&](const char* name) { return std::find(extensionNames.begin(), extensionNames.end(), name) != extensionNames.end(); };
        printf("Vulkan report:   %zu device extensions\n", extensionNames.size());
        PrintWords("Vulkan report:   extensions:", extensionNames);

        const uint32_t apiVersion = properties.apiVersion;
        std::vector<std::string> missing12, missing13;
        if (apiVersion < VK_API_VERSION_1_2)
        {
            for (const char* name : kPromoted12)
            {
                if (!has(name))
                    missing12.push_back(name);
            }
            PrintWords("Vulkan report:   Vulkan 1.2 extensions missing:", missing12);
        }
        if (apiVersion < VK_API_VERSION_1_3)
        {
            for (const char* name : kPromoted13)
            {
                if (!has(name))
                    missing13.push_back(name);
            }
            PrintWords("Vulkan report:   Vulkan 1.3 extensions missing:", missing13);
        }

        // Features: Vulkan 1.0's; the 1.1, 1.2 and 1.3 structs on a driver of that version, and on an
        // older one, the structs of the extensions it has (only those: an unknown struct in the chain
        // isn't allowed).
        if (!getFeatures2 || apiVersion < VK_API_VERSION_1_1)
        {
            VkPhysicalDeviceFeatures features = {};
            getFeatures(physicalDevice, &features);
            PrintMissing("Vulkan 1.0", &features, kFeatures10, std::size(kFeatures10));
        }
        else
        {
            VkPhysicalDeviceFeatures2 features2 = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
            void** next = &features2.pNext;
            auto chain = [&](auto& feature) {
                *next = &feature;
                next = &feature.pNext;
            };

            VkPhysicalDeviceVulkan11Features features11 = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_FEATURES };
            VkPhysicalDeviceVulkan12Features features12 = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES };
            VkPhysicalDeviceVulkan13Features features13 = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES };
            VkPhysicalDevice16BitStorageFeatures storage16 = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_16BIT_STORAGE_FEATURES };
            VkPhysicalDeviceShaderDrawParametersFeatures drawParameters = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_DRAW_PARAMETERS_FEATURES };
            VkPhysicalDeviceTimelineSemaphoreFeatures timeline = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TIMELINE_SEMAPHORE_FEATURES };
            VkPhysicalDeviceDescriptorIndexingFeatures descriptorIndexing = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DESCRIPTOR_INDEXING_FEATURES };
            VkPhysicalDeviceBufferDeviceAddressFeatures bufferDeviceAddress = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_BUFFER_DEVICE_ADDRESS_FEATURES };
            VkPhysicalDevice8BitStorageFeatures storage8 = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_8BIT_STORAGE_FEATURES };
            VkPhysicalDeviceShaderFloat16Int8Features float16Int8 = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_FLOAT16_INT8_FEATURES };
            VkPhysicalDeviceScalarBlockLayoutFeatures scalarBlockLayout = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SCALAR_BLOCK_LAYOUT_FEATURES };
            VkPhysicalDeviceHostQueryResetFeatures hostQueryReset = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_HOST_QUERY_RESET_FEATURES };
            VkPhysicalDeviceVulkanMemoryModelFeatures memoryModel = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_MEMORY_MODEL_FEATURES };
            VkPhysicalDeviceSynchronization2Features synchronization2 = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SYNCHRONIZATION_2_FEATURES };
            VkPhysicalDeviceDynamicRenderingFeatures dynamicRendering = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DYNAMIC_RENDERING_FEATURES };
            VkPhysicalDeviceExtendedDynamicStateFeaturesEXT extendedDynamicState = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTENDED_DYNAMIC_STATE_FEATURES_EXT };
            VkPhysicalDeviceMaintenance4Features maintenance4 = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_4_FEATURES };
            VkPhysicalDeviceShaderDemoteToHelperInvocationFeatures demoteToHelper = {
                VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_DEMOTE_TO_HELPER_INVOCATION_FEATURES };
            VkPhysicalDeviceSubgroupSizeControlFeatures subgroupSizeControl = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_SIZE_CONTROL_FEATURES };

            // Each extension struct's report, if it was chained
            struct Chained
            {
                const char* name;
                const void* features;
                const Field* fields;
                size_t fieldNum;
            };
            std::vector<Chained> chained;
#define CHAIN_IF(extension, name, feature, fields)                                    \
    if (has(extension))                                                             \
    {                                                                               \
        chain(feature);                                                             \
        chained.push_back({ name, &feature, fields, std::size(fields) });           \
    }

            if (apiVersion >= VK_API_VERSION_1_2)
            {
                chain(features11);
                chain(features12);
            }
            else
            {
                chain(storage16);
                chained.push_back({ "16bit storage (1.1)", &storage16, kStorage16, std::size(kStorage16) });
                chain(drawParameters);
                chained.push_back({ "shader draw parameters (1.1)", &drawParameters, kShaderDrawParameters, std::size(kShaderDrawParameters) });
                CHAIN_IF("VK_KHR_timeline_semaphore", "VK_KHR_timeline_semaphore", timeline, kTimeline)
                CHAIN_IF("VK_EXT_descriptor_indexing", "VK_EXT_descriptor_indexing", descriptorIndexing, kDescriptorIndexing)
                CHAIN_IF("VK_KHR_buffer_device_address", "VK_KHR_buffer_device_address", bufferDeviceAddress, kBufferDeviceAddress)
                CHAIN_IF("VK_KHR_8bit_storage", "VK_KHR_8bit_storage", storage8, kStorage8)
                CHAIN_IF("VK_KHR_shader_float16_int8", "VK_KHR_shader_float16_int8", float16Int8, kFloat16Int8)
                CHAIN_IF("VK_EXT_scalar_block_layout", "VK_EXT_scalar_block_layout", scalarBlockLayout, kScalarBlockLayout)
                CHAIN_IF("VK_EXT_host_query_reset", "VK_EXT_host_query_reset", hostQueryReset, kHostQueryReset)
                CHAIN_IF("VK_KHR_vulkan_memory_model", "VK_KHR_vulkan_memory_model", memoryModel, kMemoryModel)
            }
            if (apiVersion >= VK_API_VERSION_1_3)
                chain(features13);
            else
            {
                CHAIN_IF("VK_KHR_synchronization2", "VK_KHR_synchronization2", synchronization2, kSynchronization2)
                CHAIN_IF("VK_KHR_dynamic_rendering", "VK_KHR_dynamic_rendering", dynamicRendering, kDynamicRendering)
                CHAIN_IF("VK_EXT_extended_dynamic_state", "VK_EXT_extended_dynamic_state", extendedDynamicState, kExtendedDynamicState)
                CHAIN_IF("VK_KHR_maintenance4", "VK_KHR_maintenance4", maintenance4, kMaintenance4)
                CHAIN_IF("VK_EXT_shader_demote_to_helper_invocation", "VK_EXT_shader_demote_to_helper_invocation", demoteToHelper,
                    kDemoteToHelper)
                CHAIN_IF("VK_EXT_subgroup_size_control", "VK_EXT_subgroup_size_control", subgroupSizeControl, kSubgroupSizeControl)
            }
#undef CHAIN_IF

            getFeatures2(physicalDevice, &features2);
            PrintMissing("Vulkan 1.0", &features2.features, kFeatures10, std::size(kFeatures10));
            if (apiVersion >= VK_API_VERSION_1_2)
            {
                PrintMissing("Vulkan 1.1", &features11, kFeatures11, std::size(kFeatures11));
                PrintMissing("Vulkan 1.2", &features12, kFeatures12, std::size(kFeatures12));
            }
            if (apiVersion >= VK_API_VERSION_1_3)
                PrintMissing("Vulkan 1.3", &features13, kFeatures13, std::size(kFeatures13));
            for (const Chained& entry : chained)
                PrintMissing(entry.name, entry.features, entry.fields, entry.fieldNum);
        }

        // Subgroups (core in 1.1)
        if (getProperties2 && apiVersion >= VK_API_VERSION_1_1)
        {
            VkPhysicalDeviceSubgroupProperties subgroup = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_PROPERTIES };
            VkPhysicalDeviceProperties2 properties2 = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, &subgroup };
            getProperties2(physicalDevice, &properties2);
            printf("Vulkan report:   subgroups: size %u, compute %s, operations: %s\n", subgroup.subgroupSize,
                (subgroup.supportedStages & VK_SHADER_STAGE_COMPUTE_BIT) ? "yes" : "no", SubgroupOperations(subgroup.supportedOperations).c_str());
        }

        const VkPhysicalDeviceLimits& limits = properties.limits;
        printf("Vulkan report:   limits: compute shared memory %u, invocations %u, group size %u x %u x %u, group count %u x %u x %u\n",
            limits.maxComputeSharedMemorySize, limits.maxComputeWorkGroupInvocations, limits.maxComputeWorkGroupSize[0],
            limits.maxComputeWorkGroupSize[1], limits.maxComputeWorkGroupSize[2], limits.maxComputeWorkGroupCount[0],
            limits.maxComputeWorkGroupCount[1], limits.maxComputeWorkGroupCount[2]);
        printf("Vulkan report:   limits: storage buffer range %u, per stage storage buffers %u, sampled images %u, storage images %u, "
               "push constants %u, bound sets %u\n",
            limits.maxStorageBufferRange, limits.maxPerStageDescriptorStorageBuffers, limits.maxPerStageDescriptorSampledImages,
            limits.maxPerStageDescriptorStorageImages, limits.maxPushConstantsSize, limits.maxBoundDescriptorSets);

        uint32_t familyNum = 0;
        getQueueFamilies(physicalDevice, &familyNum, nullptr);
        std::vector<VkQueueFamilyProperties> families(familyNum);
        getQueueFamilies(physicalDevice, &familyNum, families.data());
        for (uint32_t i = 0; i < familyNum; i++)
        {
            printf("Vulkan report:   queue family %u: %u queues, %s, timestamp bits %u\n", i, families[i].queueCount,
                QueueFlags(families[i].queueFlags).c_str(), families[i].timestampValidBits);
        }
    }
}

void ReportVulkanDevice()
{
    void* library = dlopen("libvulkan.so", RTLD_NOW | RTLD_LOCAL);
    if (!library)
    {
        printf("Vulkan report: no libvulkan.so\n");
        return;
    }

    Loader vk;
    vk.getInstanceProcAddr = reinterpret_cast<PFN_vkGetInstanceProcAddr>(dlsym(library, "vkGetInstanceProcAddr"));
    if (!vk.getInstanceProcAddr)
    {
        printf("Vulkan report: no vkGetInstanceProcAddr\n");
        dlclose(library);
        return;
    }

    uint32_t instanceVersion = VK_API_VERSION_1_0;
    auto enumerateInstanceVersion = vk.Get<PFN_vkEnumerateInstanceVersion>("vkEnumerateInstanceVersion");
    if (enumerateInstanceVersion)
        enumerateInstanceVersion(&instanceVersion);
    printf("Vulkan report: instance (loader) Vulkan %s\n", Version(instanceVersion).c_str());

    VkApplicationInfo application = { VK_STRUCTURE_TYPE_APPLICATION_INFO };
    application.pApplicationName = "Vulkan report";
    application.apiVersion = std::min<uint32_t>(instanceVersion, VK_API_VERSION_1_3);
    VkInstanceCreateInfo info = { VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO };
    info.pApplicationInfo = &application;
    auto createInstance = vk.Get<PFN_vkCreateInstance>("vkCreateInstance");
    VkResult result = createInstance ? createInstance(&info, nullptr, &vk.instance) : VK_ERROR_INITIALIZATION_FAILED;
    if (result != VK_SUCCESS)
    {
        printf("Vulkan report: vkCreateInstance returned %d\n", (int)result);
        dlclose(library);
        return;
    }

    auto enumeratePhysicalDevices = vk.Get<PFN_vkEnumeratePhysicalDevices>("vkEnumeratePhysicalDevices");
    uint32_t deviceNum = 0;
    if (enumeratePhysicalDevices)
        enumeratePhysicalDevices(vk.instance, &deviceNum, nullptr);
    std::vector<VkPhysicalDevice> devices(deviceNum);
    if (deviceNum)
        enumeratePhysicalDevices(vk.instance, &deviceNum, devices.data());
    printf("Vulkan report: %u physical devices\n", deviceNum);
    for (uint32_t i = 0; i < deviceNum; i++)
        ReportPhysicalDevice(vk, devices[i], i, application.apiVersion >= VK_API_VERSION_1_1);

    if (auto destroyInstance = vk.Get<PFN_vkDestroyInstance>("vkDestroyInstance"))
        destroyInstance(vk.instance, nullptr);
    dlclose(library);
    fflush(stdout);
}

#else

void ReportVulkanDevice()
{
}

#endif
