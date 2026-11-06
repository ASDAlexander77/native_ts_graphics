// The ptlas example's scene, shared by its animation (ptlas_animate.hlsl) and ray tracing
// (ptlas.hlsl) shaders: a 16 x 16 grid of cubes in 16 partitions of 4 x 4 (a partition per tile), a
// ground plane and 8 cubes orbiting above, the last 9 in the global partition. Everything is a
// function of the frame index, so that the reference TLAS can be rebuilt each frame from what the
// PTLAS's sparse operations have accumulated.

static const uint GridSize = 16;
static const uint TileSize = 4;
static const uint TilesPerRow = GridSize / TileSize;
static const uint PartitionCount = TilesPerRow * TilesPerRow;
static const uint InstancesPerPartition = TileSize * TileSize;
static const uint GridInstanceCount = GridSize * GridSize;
static const uint GroundInstance = GridInstanceCount;
static const uint OrbiterCount = 8;
static const uint FirstOrbiter = GroundInstance + 1;
static const uint InstanceCount = FirstOrbiter + OrbiterCount;
// VK_PARTITIONED_ACCELERATION_STRUCTURE_PARTITION_INDEX_GLOBAL_NV,
// D3D12_RTAS_PARTITIONED_TLAS_PARTITION_INDEX_GLOBAL_PARTITION.
static const uint GlobalPartition = 0xffffffff;

// Each second (60 frames) one tile spins (its cubes rewritten every frame), and from the second
// second on, half the cubes of another tile swap their BLAS (cube <-> octahedron) by an instance
// update at the second's first frame.
static const uint FramesPerPhase = 60;
static const float SpinPerFrame = 0.03;
static const float BobPerFrame = 0.05;
static const float OrbitPerFrame = 0.01;
static const float CubeSpacing = 1.5;

static const uint Blas_Cube = 0;
static const uint Blas_Octahedron = 1;
static const uint Blas_Ground = 2;

uint SpinningPartition(uint frame)
{
    return (frame / FramesPerPhase) % PartitionCount;
}

uint SwappingPartition(uint phase)
{
    return (phase + PartitionCount / 2) % PartitionCount;
}

// The grid instance's partition and its index in it.
uint PartitionOf(uint instance)
{
    uint x = instance % GridSize;
    uint z = instance / GridSize;
    return (z / TileSize) * TilesPerRow + x / TileSize;
}

uint IndexInPartition(uint instance)
{
    uint x = instance % GridSize;
    uint z = instance / GridSize;
    return (z % TileSize) * TileSize + x % TileSize;
}

// Half the tile's cubes, in a checkerboard, swap their BLAS.
bool Swaps(uint indexInPartition)
{
    return ((indexInPartition % TileSize) + indexInPartition / TileSize) % 2 == 0;
}

// The partition's translation (a bob up and down).
float3 PartitionTranslation(uint partition, uint frame)
{
    return float3(0, 0.6 * (0.5 + 0.5 * sin(float(frame) * BobPerFrame + float(partition))), 0);
}

// The angle of a grid cube's spin: that of the last frame its tile spun (frame 0's, 0, if never).
float SpinAngle(uint partition, uint frame)
{
    uint phase = frame / FramesPerPhase;
    if (SpinningPartition(frame) == partition)
        return float(frame) * SpinPerFrame;
    // The last phase before this one in which it spun.
    uint behind = (phase + PartitionCount - partition) % PartitionCount;
    if (behind > phase)
        return 0;
    uint lastFrame = (phase - behind) * FramesPerPhase + FramesPerPhase - 1;
    return float(lastFrame) * SpinPerFrame;
}

// The BLAS of a grid cube: swapped at the first frame of each phase (from 1) in which its tile was
// the swapping one, if it's one of the checkerboard's.
uint GridBlas(uint partition, uint indexInPartition, uint frame)
{
    if (!Swaps(indexInPartition))
        return Blas_Cube;
    uint phase = frame / FramesPerPhase;
    // Phases k in [1, phase] with SwappingPartition(k) == partition: k = r, r + 16, ...
    uint r = (partition + PartitionCount - PartitionCount / 2) % PartitionCount;
    uint swaps = 0;
    if (r == 0)
        swaps = phase / PartitionCount;
    else if (phase >= r)
        swaps = (phase - r) / PartitionCount + 1;
    return (swaps % 2) == 0 ? Blas_Cube : Blas_Octahedron;
}

// A row-major 3x4 transform, without the partition translation, and the instance's BLAS.
struct InstanceState
{
    float4 rows[3];
    uint blas;
    uint partition;
};

InstanceState GetInstanceState(uint instance, uint frame)
{
    InstanceState state;
    if (instance < GridInstanceCount)
    {
        uint partition = PartitionOf(instance);
        float angle = SpinAngle(partition, frame);
        float c = cos(angle);
        float s = sin(angle);
        float x = (float(instance % GridSize) - (GridSize - 1) * 0.5) * CubeSpacing;
        float z = (float(instance / GridSize) - (GridSize - 1) * 0.5) * CubeSpacing;
        state.rows[0] = float4(c, 0, s, x);
        state.rows[1] = float4(0, 1, 0, 0.5);
        state.rows[2] = float4(-s, 0, c, z);
        state.blas = GridBlas(partition, IndexInPartition(instance), frame);
        state.partition = partition;
    }
    else if (instance == GroundInstance)
    {
        state.rows[0] = float4(16, 0, 0, 0);
        state.rows[1] = float4(0, 1, 0, 0);
        state.rows[2] = float4(0, 0, 16, 0);
        state.blas = Blas_Ground;
        state.partition = GlobalPartition;
    }
    else
    {
        float angle = float(frame) * OrbitPerFrame + float(instance - FirstOrbiter) * (6.2831853 / OrbiterCount);
        float c = cos(angle * 3.0);
        float s = sin(angle * 3.0);
        state.rows[0] = float4(c, 0, s, 9.0 * cos(angle));
        state.rows[1] = float4(0, 1, 0, 3.0);
        state.rows[2] = float4(-s, 0, c, 9.0 * sin(angle));
        state.blas = Blas_Cube;
        state.partition = GlobalPartition;
    }
    return state;
}
