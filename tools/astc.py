"""ASTC decoding of 2D LDR textures to RGBA8, for ktx_to_dds.py.

Decodes as astc-encoder does when it writes 8-bit outputs (the Vulkan-Samples framework decodes
ASTC textures with it on GPUs without ASTC support): endpoints expanded to 16 bits (by replication,
or for sRGB data by `<< 8 | 0x80`), interpolated, and the top 8 bits kept. The bitstream layout,
quantization tables and partition function are those of the Khronos Data Format Specification's
ASTC chapter. HDR endpoint modes and HDR void-extent blocks decode to the error color (magenta), as
in an LDR profile.

    decode(data, width, height, block_width, block_height, srgb) -> bytes (RGBA8 rows)
"""

# The quantization levels, indexed as in block modes and color endpoint quantization (QUANT_2 is
# 0, QUANT_256 20): (levels, trits, quints, bits).
QUANT_LEVELS = [
    (2, 0, 0, 1), (3, 1, 0, 0), (4, 0, 0, 2), (5, 0, 1, 0), (6, 1, 0, 1), (8, 0, 0, 3),
    (10, 0, 1, 1), (12, 1, 0, 2), (16, 0, 0, 4), (20, 0, 1, 2), (24, 1, 0, 3), (32, 0, 0, 5),
    (40, 0, 1, 3), (48, 1, 0, 4), (64, 0, 0, 6), (80, 0, 1, 4), (96, 1, 0, 5), (128, 0, 0, 7),
    (160, 0, 1, 5), (192, 1, 0, 6), (256, 0, 0, 8),
]
QUANT_6 = 4

ERROR_COLOR = (0xFF, 0x00, 0xFF, 0xFF)


def ise_bit_count(count, quant):
    """Bits of an integer sequence of `count` values at a quantization level."""
    _, trits, quints, bits = QUANT_LEVELS[quant]
    total = bits * count
    if trits:
        total += (8 * count + 4) // 5
    if quints:
        total += (7 * count + 2) // 3
    return total


def _bits(value, high, low):
    return (value >> low) & ((1 << (high - low + 1)) - 1)


def _decode_trits(t):
    """The five trits packed in 8 bits."""
    if _bits(t, 4, 2) == 7:
        c = (_bits(t, 7, 5) << 2) | _bits(t, 1, 0)
        t4 = t3 = 2
    else:
        c = _bits(t, 4, 0)
        if _bits(t, 6, 5) == 3:
            t4 = 2
            t3 = _bits(t, 7, 7)
        else:
            t4 = _bits(t, 7, 7)
            t3 = _bits(t, 6, 5)
    c0, c1, c2, c3, c4 = (_bits(c, i, i) for i in range(5))
    if _bits(c, 1, 0) == 3:
        t2 = 2
        t1 = c4
        t0 = (c3 << 1) | (c2 & (1 - c3))
    elif _bits(c, 3, 2) == 3:
        t2 = 2
        t1 = 2
        t0 = _bits(c, 1, 0)
    else:
        t2 = c4
        t1 = _bits(c, 3, 2)
        t0 = (c1 << 1) | (c0 & (1 - c1))
    return (t0, t1, t2, t3, t4)


def _decode_quints(q):
    """The three quints packed in 7 bits."""
    q0b, q3b, q4b = _bits(q, 0, 0), _bits(q, 3, 3), _bits(q, 4, 4)
    if _bits(q, 2, 1) == 3 and _bits(q, 6, 5) == 0:
        r2 = (q0b << 2) | ((q4b & (1 - q0b)) << 1) | (q3b & (1 - q0b))
        r1 = r0 = 4
    else:
        if _bits(q, 2, 1) == 3:
            r2 = 4
            c = (_bits(q, 4, 3) << 3) | ((~_bits(q, 6, 5) & 3) << 1) | q0b
        else:
            r2 = _bits(q, 6, 5)
            c = _bits(q, 4, 0)
        if _bits(c, 2, 0) == 5:
            r1 = 4
            r0 = _bits(c, 4, 3)
        else:
            r1 = _bits(c, 4, 3)
            r0 = _bits(c, 2, 0)
    return (r0, r1, r2)


TRITS = [_decode_trits(t) for t in range(256)]
QUINTS = [_decode_quints(q) for q in range(128)]


def decode_ise(value, offset, count, quant):
    """`count` values of an integer sequence starting at bit `offset` of `value`; bits past the
    end of the sequence read as 0."""
    _, trits, quints, bits = QUANT_LEVELS[quant]
    seq = (value >> offset) & ((1 << ise_bit_count(count, quant)) - 1)
    mask = (1 << bits) - 1
    out = []
    pos = 0
    if trits:
        # m0 T[1:0] m1 T[3:2] m2 T[4] m3 T[6:5] m4 T[7]
        packed_bits = (2, 2, 1, 2, 1)
        group = 5
        table = TRITS
    elif quints:
        # m0 Q[2:0] m1 Q[4:3] m2 Q[6:5]
        packed_bits = (3, 2, 2)
        group = 3
        table = QUINTS
    else:
        for _ in range(count):
            out.append((seq >> pos) & mask)
            pos += bits
        return out
    while len(out) < count:
        low = []
        packed = 0
        shift = 0
        for n in packed_bits:
            low.append((seq >> pos) & mask)
            pos += bits
            packed |= ((seq >> pos) & ((1 << n) - 1)) << shift
            pos += n
            shift += n
        high = table[packed]
        for i in range(min(group, count - len(out))):
            out.append((high[i] << bits) | low[i])
    return out


def _replicate(value, bits, to_bits):
    """`value` of `bits` bits widened to `to_bits` by bit replication."""
    result = 0
    shift = to_bits
    while shift > 0:
        shift -= bits
        result |= value << shift if shift >= 0 else value >> -shift
    return result


def _pattern(pattern, m):
    """A B constant of the unquantization tables: letters are bits of m (b = bit 1, c = bit 2...)."""
    result = 0
    for ch in pattern:
        result = (result << 1) | (0 if ch == "0" else (m >> (ord(ch) - ord("a"))) & 1)
    return result


# levels -> (B pattern, C), the trit and quint rows of the unquantization tables.
WEIGHT_TABLE = {6: ("0000000", 50), 10: ("0000000", 28), 12: ("b000b0b", 23), 20: ("b0000b0", 13),
                24: ("cb000cb", 11)}
COLOR_TABLE = {6: ("000000000", 204), 10: ("000000000", 113), 12: ("b000b0bb0", 93),
               20: ("b0000bb00", 54), 24: ("cb000cbcb", 44), 40: ("cb0000cbc", 26),
               48: ("dcb000dcb", 22), 80: ("dcb0000dc", 13), 96: ("edcb000ed", 11),
               160: ("edcb0000e", 6), 192: ("fedcb000f", 5)}


def _unquantize_weight(quant, value):
    levels, trits, quints, bits = QUANT_LEVELS[quant]
    if not trits and not quints:
        result = _replicate(value, bits, 6)
    elif bits == 0:
        result = {3: (0, 32, 63), 5: (0, 16, 32, 47, 63)}[levels][value]
    else:
        m = value & ((1 << bits) - 1)
        a = 0x7F if m & 1 else 0
        pattern, c = WEIGHT_TABLE[levels]
        t = ((value >> bits) * c + _pattern(pattern, m)) ^ a
        result = (a & 0x20) | (t >> 2)
    return result + 1 if result > 32 else result


def _unquantize_color(quant, value):
    levels, trits, quints, bits = QUANT_LEVELS[quant]
    if not trits and not quints:
        return _replicate(value, bits, 8)
    m = value & ((1 << bits) - 1)
    a = 0x1FF if m & 1 else 0
    pattern, c = COLOR_TABLE[levels]
    t = ((value >> bits) * c + _pattern(pattern, m)) ^ a
    return (a & 0x80) | (t >> 2)


def _levels(quant):
    return QUANT_LEVELS[quant][0]


WEIGHT_UNQUANT = [[_unquantize_weight(q, v) for v in range(_levels(q))] if q <= 11 else None
                  for q in range(len(QUANT_LEVELS))]
COLOR_UNQUANT = [[_unquantize_color(q, v) for v in range(_levels(q))] if q >= QUANT_6 else None
                 for q in range(len(QUANT_LEVELS))]


def color_quant_level(count, bits):
    """The finest quantization of `count` color values that fits in `bits` bits (-1 if none)."""
    for quant in range(len(QUANT_LEVELS) - 1, -1, -1):
        if ise_bit_count(count, quant) <= bits:
            return quant
    return -1


def _block_mode(mode, block_width, block_height):
    """(weights x, weights y, dual plane, weight quant, weight bits) of a 2D block mode, or None
    if it's reserved or invalid for the block size."""
    quant = (mode >> 4) & 1
    h = (mode >> 9) & 1
    d = (mode >> 10) & 1
    a = (mode >> 5) & 3
    if mode & 3:
        quant |= (mode & 3) << 1
        b = (mode >> 7) & 3
        kind = (mode >> 2) & 3
        if kind == 0:
            x, y = b + 4, a + 2
        elif kind == 1:
            x, y = b + 8, a + 2
        elif kind == 2:
            x, y = a + 2, b + 8
        elif mode & 0x100:
            x, y = (b & 1) + 2, a + 2
        else:
            x, y = a + 2, (b & 1) + 6
    else:
        quant |= ((mode >> 2) & 3) << 1
        if (mode >> 2) & 3 == 0:
            return None
        b = (mode >> 9) & 3
        kind = (mode >> 7) & 3
        if kind == 0:
            x, y = 12, a + 2
        elif kind == 1:
            x, y = a + 2, 12
        elif kind == 2:
            x, y = a + 6, b + 6
            d = h = 0
        elif a == 0:
            x, y = 6, 10
        elif a == 1:
            x, y = 10, 6
        else:
            return None
    count = x * y * (d + 1)
    quant = quant - 2 + 6 * h
    weight_bits = ise_bit_count(count, quant)
    if x > block_width or y > block_height or count > 64 or not 24 <= weight_bits <= 96:
        return None
    return x, y, d != 0, quant, weight_bits


def _decimation(block_width, block_height, x_weights, y_weights):
    """For each texel, its (weight index, contribution) pairs; the contributions add up to 16."""
    texels = []
    for y in range(block_height):
        for x in range(block_width):
            xw = (((1024 + block_width // 2) // (block_width - 1)) * x * (x_weights - 1) + 32) >> 6
            yw = (((1024 + block_height // 2) // (block_height - 1)) * y * (y_weights - 1) + 32) >> 6
            fx, fy = xw & 0xF, yw & 0xF
            base = (xw >> 4) + (yw >> 4) * x_weights
            w11 = (fx * fy + 8) >> 4
            pairs = ((base, 16 - fx - fy + w11), (base + 1, fx - w11), (base + x_weights, fy - w11),
                     (base + x_weights + 1, w11))
            texels.append(tuple(p for p in pairs if p[1] != 0))
    return texels


def _hash52(p):
    p &= 0xFFFFFFFF
    p ^= p >> 15
    p = (p * 0xEEDE0891) & 0xFFFFFFFF
    p ^= p >> 5
    p = (p + (p << 16)) & 0xFFFFFFFF
    p ^= p >> 7
    p ^= p >> 3
    p = (p ^ (p << 6)) & 0xFFFFFFFF
    p ^= p >> 17
    return p


def _select_partition(seed, x, y, z, count, small_block):
    if small_block:
        x <<= 1
        y <<= 1
        z <<= 1
    seed += (count - 1) * 1024
    rnum = _hash52(seed)
    seeds = [(rnum >> s) & 0xF for s in (0, 4, 8, 12, 16, 20, 24, 28, 18, 22, 26)]
    seeds.append(((rnum >> 30) | (rnum << 2)) & 0xF)
    seeds = [s * s for s in seeds]
    if seed & 1:
        sh1 = 4 if seed & 2 else 5
        sh2 = 6 if count == 3 else 5
    else:
        sh1 = 6 if count == 3 else 5
        sh2 = 4 if seed & 2 else 5
    sh3 = sh1 if seed & 0x10 else sh2
    s = [seeds[i] >> (sh1 if i % 2 == 0 else sh2) for i in range(8)] + [v >> sh3 for v in seeds[8:]]
    a = (s[0] * x + s[1] * y + s[10] * z + (rnum >> 14)) & 0x3F
    b = (s[2] * x + s[3] * y + s[11] * z + (rnum >> 10)) & 0x3F
    c = (s[4] * x + s[5] * y + s[8] * z + (rnum >> 6)) & 0x3F
    d = (s[6] * x + s[7] * y + s[9] * z + (rnum >> 2)) & 0x3F
    if count <= 3:
        d = 0
    if count <= 2:
        c = 0
    if a >= b and a >= c and a >= d:
        return 0
    if b >= c and b >= d:
        return 1
    if c >= d:
        return 2
    return 3


def _clamp(value):
    return 0 if value < 0 else 255 if value > 255 else value


def _uncontract(color):
    return [(color[0] + color[2]) >> 1, (color[1] + color[2]) >> 1, color[2], color[3]]


def _bit_transfer_signed(a, b):
    """(a, b) of the specification's bit_transfer_signed: b gets a's top bit, a becomes a signed
    6-bit delta."""
    b = (b >> 1) | (a & 0x80)
    a = (a >> 1) & 0x3F
    return (a - 0x40 if a & 0x20 else a), b


def _endpoints(cem, v):
    """The 8-bit endpoint pair of an LDR color endpoint mode, or None for an HDR one."""
    if cem == 0:
        return [v[0], v[0], v[0], 255], [v[1], v[1], v[1], 255]
    if cem == 1:
        l0 = (v[0] >> 2) | (v[1] & 0xC0)
        l1 = min(l0 + (v[1] & 0x3F), 255)
        return [l0, l0, l0, 255], [l1, l1, l1, 255]
    if cem == 4:
        return [v[0], v[0], v[0], v[2]], [v[1], v[1], v[1], v[3]]
    if cem == 5:
        l1, l0 = _bit_transfer_signed(v[1], v[0])
        a1, a0 = _bit_transfer_signed(v[3], v[2])
        l1 = _clamp(l0 + l1)
        a1 = _clamp(a0 + a1)
        return [l0, l0, l0, a0], [l1, l1, l1, a1]
    if cem in (6, 10):
        alpha0, alpha1 = (v[4], v[5]) if cem == 10 else (255, 255)
        e1 = [v[0], v[1], v[2], alpha1]
        e0 = [(v[0] * v[3]) >> 8, (v[1] * v[3]) >> 8, (v[2] * v[3]) >> 8, alpha0]
        return e0, e1
    if cem in (8, 12):
        e0 = [v[0], v[2], v[4], v[6] if cem == 12 else 255]
        e1 = [v[1], v[3], v[5], v[7] if cem == 12 else 255]
        if e0[0] + e0[1] + e0[2] > e1[0] + e1[1] + e1[2]:
            return _uncontract(e1), _uncontract(e0)
        return e0, e1
    if cem in (9, 13):
        base = [v[0], v[2], v[4], v[6] if cem == 13 else 0]
        delta = [v[1], v[3], v[5], v[7] if cem == 13 else 0]
        for i in range(4):
            delta[i], base[i] = _bit_transfer_signed(delta[i], base[i])
        rgb_sum = delta[0] + delta[1] + delta[2]
        e0 = base
        e1 = [base[i] + delta[i] for i in range(4)]
        if rgb_sum < 0:
            e0, e1 = _uncontract(e1), _uncontract(e0)
        e0 = [_clamp(c) for c in e0]
        e1 = [_clamp(c) for c in e1]
        if cem == 9:
            e0[3] = e1[3] = 255
        return e0, e1
    return None


class Decoder:
    """Decodes blocks of one size; caches the per-block-mode and per-partitioning tables."""

    def __init__(self, block_width, block_height, srgb):
        self.block_width = block_width
        self.block_height = block_height
        self.texel_count = block_width * block_height
        self.srgb = srgb
        self.modes = {}
        self.decimations = {}
        self.partitions = {}
        self.reverse8 = bytes(int(f"{i:08b}"[::-1], 2) for i in range(256))

    def _mode(self, mode):
        if mode not in self.modes:
            info = _block_mode(mode, self.block_width, self.block_height)
            if info is not None:
                key = (info[0], info[1])
                if key not in self.decimations:
                    self.decimations[key] = _decimation(self.block_width, self.block_height, *key)
                info = info + (self.decimations[key],)
            self.modes[mode] = info
        return self.modes[mode]

    def _partitioning(self, seed, count):
        key = (seed, count)
        if key not in self.partitions:
            small = self.texel_count < 31
            self.partitions[key] = [_select_partition(seed, x, y, 0, count, small)
                                    for y in range(self.block_height) for x in range(self.block_width)]
        return self.partitions[key]

    def _expand(self, endpoint):
        if self.srgb:
            return [(c << 8) | 0x80 for c in endpoint]
        return [c * 257 for c in endpoint]

    def decode_block(self, block):
        """The block's texels (16 bytes in), as a list of (r, g, b, a) tuples in row order."""
        error = [ERROR_COLOR] * self.texel_count
        value = int.from_bytes(block, "little")
        mode = value & 0x7FF

        if mode & 0x1FF == 0x1FC:
            # Void-extent block: one 16-bit color (HDR ones are errors in LDR profiles).
            if mode & 0x200 or (value >> 10) & 3 != 3:
                return error
            color = tuple(((value >> (64 + 16 * i)) & 0xFFFF) >> 8 for i in range(4))
            return [color] * self.texel_count

        info = self._mode(mode)
        if info is None:
            return error
        x_weights, y_weights, dual_plane, weight_quant, weight_bits, decimation = info
        partition_count = ((value >> 11) & 3) + 1
        if dual_plane and partition_count == 4:
            return error

        # The weights are stored bit-reversed from the top of the block.
        reversed_value = int.from_bytes(bytes(self.reverse8[b] for b in reversed(block)), "little")
        weight_count = x_weights * y_weights
        raw = decode_ise(reversed_value, 0, weight_count * (2 if dual_plane else 1), weight_quant)
        unquant = WEIGHT_UNQUANT[weight_quant]
        raw = [unquant[w] for w in raw]
        planes = [raw[0::2], raw[1::2]] if dual_plane else [raw]

        below_weights = 128 - weight_bits
        extra_cem_bits = 0
        if partition_count == 1:
            cems = [(value >> 13) & 0xF]
            seed = 0
        else:
            seed = (value >> 13) & 0x3FF
            cem_bits = (value >> 23) & 0x3F
            if cem_bits & 3 == 0:
                cems = [(cem_bits >> 2) & 0xF] * partition_count
            else:
                extra_cem_bits = 3 * partition_count - 4
                cem_bits |= ((value >> (below_weights - extra_cem_bits)) & ((1 << extra_cem_bits) - 1)) << 6
                base_class = (cem_bits & 3) - 1
                cems = []
                for i in range(partition_count):
                    cems.append((((cem_bits >> (2 + i)) & 1) + base_class) << 2)
                for i in range(partition_count):
                    cems[i] |= (cem_bits >> (2 + partition_count + 2 * i)) & 3

        color_count = sum(((cem >> 2) + 1) * 2 for cem in cems)
        if color_count > 18:
            return error
        color_bits = (115 - 4 if partition_count == 1 else 113 - 4 - 10) - weight_bits - extra_cem_bits
        if dual_plane:
            color_bits -= 2
        color_quant = color_quant_level(color_count, max(color_bits, 0))
        if color_quant < QUANT_6:
            return error
        colors = decode_ise(value, 17 if partition_count == 1 else 29, color_count, color_quant)
        unquant = COLOR_UNQUANT[color_quant]
        colors = [unquant[c] for c in colors]

        endpoints = []
        for cem in cems:
            n = ((cem >> 2) + 1) * 2
            pair = _endpoints(cem, colors[:n])
            colors = colors[n:]
            if pair is None:
                return error
            endpoints.append((self._expand(pair[0]), self._expand(pair[1])))

        plane2_component = (value >> (below_weights - extra_cem_bits - 2)) & 3 if dual_plane else -1
        texel_weights = []
        for plane in planes:
            texel_weights.append([(sum(plane[i] * c for i, c in pairs) + 8) >> 4 for pairs in decimation])
        partition_of = self._partitioning(seed, partition_count) if partition_count > 1 else None

        out = []
        for t in range(self.texel_count):
            e0, e1 = endpoints[partition_of[t] if partition_of else 0]
            w = texel_weights[0][t]
            texel = []
            for ch in range(4):
                wc = texel_weights[1][t] if ch == plane2_component else w
                texel.append(((e0[ch] * (64 - wc) + e1[ch] * wc + 32) >> 6) >> 8)
            out.append(tuple(texel))
        return out


def decode(data, width, height, block_width, block_height, srgb):
    """RGBA8 texels of a 2D ASTC image (rows of `width` texels, top to bottom)."""
    decoder = Decoder(block_width, block_height, srgb)
    blocks_x = (width + block_width - 1) // block_width
    blocks_y = (height + block_height - 1) // block_height
    rows = [bytearray(width * 4) for _ in range(height)]
    offset = 0
    for by in range(blocks_y):
        for bx in range(blocks_x):
            texels = decoder.decode_block(data[offset:offset + 16])
            offset += 16
            for y in range(block_height):
                row_index = by * block_height + y
                if row_index >= height:
                    break
                row = rows[row_index]
                for x in range(block_width):
                    column = bx * block_width + x
                    if column >= width:
                        break
                    row[column * 4:column * 4 + 4] = bytes(texels[y * block_width + x])
    return b"".join(rows)
