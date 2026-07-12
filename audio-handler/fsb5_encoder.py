#!/usr/bin/env python3
"""
FSB5 encoder for creating FMOD Sound Bank (FSB5) data from audio files.
Supports PCM16 and Vorbis encoding.
"""

import struct
import subprocess
import tempfile
import os
import zlib
from io import BytesIO

FREQ_MAP = {8000: 1, 11000: 2, 11025: 3, 16000: 4, 22050: 5, 24000: 6, 32000: 7, 44100: 8, 48000: 9}
FREQ_MAP_REV = {v: k for k, v in FREQ_MAP.items()}


def encode_pcm16_fsb5(pcm_data, num_samples, channels, frequency):
    """Build FSB5 binary with PCM16 encoding."""
    sample_header_size = 8 + 5 + 8
    padded = (sample_header_size + 3) & ~3
    if padded < sample_header_size:
        padded += 4

    header = build_fsb5_header(1, padded, 0, len(pcm_data), 2)
    sample_hdr = build_sample_descriptor(channels, frequency, num_samples, has_more_chunks=True)
    sample_hdr += build_metadata_channels(channels, has_more_chunks=True)
    sample_hdr += build_metadata_frequency(frequency, has_more_chunks=False)

    actual_size = 8 + len(sample_hdr)
    header = build_fsb5_header(1, actual_size, 0, len(pcm_data), 2)

    return header + sample_hdr + pcm_data


def encode_vorbis_fsb5(input_path, target_freq=48000, target_channels=2):
    """Build FSB5 binary with Vorbis encoding using ffmpeg to create OGG, then parsing packets."""
    with tempfile.NamedTemporaryFile(suffix='.ogg', delete=False) as tmp:
        ogg_path = tmp.name

    try:
        cmd = [
            'ffmpeg', '-y', '-i', input_path,
            '-c:a', 'libvorbis',
            '-b:a', '192k',
            '-ar', str(target_freq),
            '-ac', str(target_channels),
            '-f', 'ogg',
            ogg_path
        ]
        subprocess.run(cmd, capture_output=True, check=True)

        with open(ogg_path, 'rb') as f:
            ogg_data = f.read()

        packets = parse_ogg_packets(ogg_data)

        if len(packets) < 4:
            raise ValueError('OGG file has fewer than 4 packets (need id, comment, setup, audio)')

        id_header = packets[0]
        comment_header = packets[1]
        setup_header = packets[2]
        audio_packets = packets[3:]

        if len(audio_packets) == 0:
            raise ValueError('No audio packets found in OGG file')

        frequency = target_freq
        channels = target_channels
        num_samples = count_vorbis_samples(ogg_data)

        crc32_val = compute_vorbis_crc32(id_header)

        audio_section = b''
        for pkt in audio_packets:
            audio_section += struct.pack('<H', len(pkt))
            audio_section += pkt

        sample_hdr = build_sample_descriptor(channels, frequency, num_samples, has_more_chunks=True)
        sample_hdr += build_metadata_vorbis(crc32_val, setup_header, has_more_chunks=False)

        header = build_fsb5_header(1, len(sample_hdr), 0, len(audio_section), 15)

        return header + sample_hdr + audio_section

    finally:
        if os.path.exists(ogg_path):
            os.unlink(ogg_path)


def build_fsb5_header(version, sample_headers_size, name_table_size, data_size, mode):
    """Build the 60-byte FSB5 file header."""
    buf = BytesIO()
    buf.write(b'FSB5')
    buf.write(struct.pack('<I', version))
    buf.write(struct.pack('<I', 1))
    buf.write(struct.pack('<I', sample_headers_size))
    buf.write(struct.pack('<I', name_table_size))
    buf.write(struct.pack('<I', data_size))
    buf.write(struct.pack('<I', mode))
    buf.write(b'\x01' + b'\x00' * 7)
    buf.write(os.urandom(16))
    buf.write(os.urandom(8))
    return buf.getvalue()


def build_sample_descriptor(channels, frequency, num_samples, data_offset_16=0, has_more_chunks=True):
    """Build the 8-byte sample descriptor."""
    freq_code = FREQ_MAP.get(frequency, 8)
    ch_bit = 1 if channels >= 2 else 0

    raw = 0
    raw |= (1 if has_more_chunks else 0)
    raw |= (freq_code & 0xF) << 1
    raw |= (ch_bit & 1) << 5
    raw |= (data_offset_16 & 0x0FFFFFFF) << 6
    raw |= (num_samples & 0x3FFFFFFF) << 34

    return struct.pack('<Q', raw)


def build_metadata_channels(channels, has_more_chunks=False):
    """Build CHANNELS metadata chunk (type=1)."""
    next_bit = 1 if has_more_chunks else 0
    chunk_type = 1
    chunk_data = struct.pack('B', channels)
    chunk_size = len(chunk_data)
    header = (next_bit & 1) | ((chunk_size & 0xFFFFFF) << 1) | ((chunk_type & 0x7F) << 25)
    return struct.pack('<I', header) + chunk_data


def build_metadata_frequency(frequency, has_more_chunks=False):
    """Build FREQUENCY metadata chunk (type=2)."""
    next_bit = 1 if has_more_chunks else 0
    chunk_type = 2
    chunk_data = struct.pack('<I', frequency)
    chunk_size = len(chunk_data)
    header = (next_bit & 1) | ((chunk_size & 0xFFFFFF) << 1) | ((chunk_type & 0x7F) << 25)
    return struct.pack('<I', header) + chunk_data


def build_metadata_vorbis(crc32_val, setup_header, has_more_chunks=False):
    """Build VORBISDATA metadata chunk (type=11)."""
    next_bit = 1 if has_more_chunks else 0
    chunk_type = 11
    chunk_data = struct.pack('<I', crc32_val) + setup_header
    chunk_size = len(chunk_data)
    header = (next_bit & 1) | ((chunk_size & 0xFFFFFF) << 1) | ((chunk_type & 0x7F) << 25)
    return struct.pack('<I', header) + chunk_data


def compute_vorbis_crc32(id_header_packet):
    """Compute the CRC32 of a Vorbis identification header packet."""
    return zlib.crc32(id_header_packet) & 0xFFFFFFFF


def parse_ogg_packets(ogg_data):
    """Parse an OGG file and extract Vorbis packets.

    OGG packets can span multiple pages. A segment of exactly 255 bytes
    means the packet continues in the next segment. A packet ends when
    a segment shorter than 255 bytes is encountered.
    """
    packets = []
    current_packet = b''
    packet_complete = False

    offset = 0
    while offset < len(ogg_data):
        if offset + 27 > len(ogg_data):
            break

        magic = ogg_data[offset:offset + 4]
        if magic != b'OggS':
            offset += 1
            continue

        header_type = ogg_data[offset + 5]
        num_segments = ogg_data[offset + 26]

        if offset + 27 + num_segments > len(ogg_data):
            break

        seg_table = ogg_data[offset + 27:offset + 27 + num_segments]
        data_start = offset + 27 + num_segments

        for seg_size in seg_table:
            current_packet += ogg_data[data_start:data_start + seg_size]
            data_start += seg_size

            if seg_size < 255:
                packet_complete = True

        if packet_complete and current_packet:
            packets.append(current_packet)
            current_packet = b''
            packet_complete = False

        offset = data_start

    return packets


def count_vorbis_samples(ogg_data):
    """Count total samples from the last granule position in OGG."""
    last_granule = 0
    offset = 0
    while offset < len(ogg_data):
        if offset + 27 > len(ogg_data):
            break
        magic = ogg_data[offset:offset + 4]
        if magic != b'OggS':
            offset += 1
            continue

        num_segments = ogg_data[offset + 26]
        granule_pos = struct.unpack_from('<q', ogg_data, offset + 6)[0]
        if granule_pos > 0:
            last_granule = granule_pos

        data_start = offset + 27 + num_segments
        for i in range(num_segments):
            seg_size = ogg_data[offset + 27 + i]
            data_start += seg_size

        offset = data_start

    return last_granule
