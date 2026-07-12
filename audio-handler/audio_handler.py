#!/usr/bin/env python3
"""
Audio Handler for What the Dub
Extracts, lists, and replaces AudioClips in Unity asset bundles.
Replaces audio by patching FSB5 data in the resource file directly.
"""

import sys
import os
import json
import shutil
import struct
import re
import subprocess
import UnityPy
from UnityPy.streams.EndianBinaryReader import EndianBinaryReader
from pydub import AudioSegment

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fsb5_encoder import encode_pcm16_fsb5

LOUDNORM_I = "-29"
LOUDNORM_TP = "-1.5"
LOUDNORM_LRA = "7"


def get_bundle_path(game_path):
    return os.path.join(game_path, "WhatTheDub_Data", "StreamingAssets", "AssetBundles", "audio-manager")


def get_backup_path(bundle_path):
    return bundle_path + ".bak"


def ensure_backup(bundle_path):
    backup = get_backup_path(bundle_path)
    if not os.path.exists(backup):
        shutil.copy2(bundle_path, backup)
        return True
    return False


def list_clips(bundle_path):
    env = UnityPy.load(bundle_path)
    clips = []
    for obj in env.objects:
        if obj.type.name == "AudioClip":
            clip = obj.read()
            entry = {
                "name": clip.m_Name,
                "duration": round(clip.m_Length, 1),
                "channels": clip.m_Channels,
                "frequency": clip.m_Frequency,
                "bitsPerSample": clip.m_BitsPerSample,
                "compressionFormat": clip.m_CompressionFormat,
                "loadType": clip.m_LoadType,
            }
            if clip.m_Resource:
                entry["resourceOffset"] = clip.m_Resource.m_Offset
                entry["resourceSize"] = clip.m_Resource.m_Size
            clips.append(entry)
    return clips


def extract_clip(bundle_path, clip_name, output_path):
    env = UnityPy.load(bundle_path)
    for obj in env.objects:
        if obj.type.name == "AudioClip":
            clip = obj.read()
            if clip.m_Name == clip_name:
                for name, wav_data in clip.samples.items():
                    with open(output_path, "wb") as f:
                        f.write(wav_data)
                    return True
    return False


def extract_all(bundle_path, output_dir):
    env = UnityPy.load(bundle_path)
    os.makedirs(output_dir, exist_ok=True)
    count = 0
    for obj in env.objects:
        if obj.type.name == "AudioClip":
            clip = obj.read()
            for name, wav_data in clip.samples.items():
                safe_name = clip.m_Name.replace("/", "_").replace("\\", "_").replace(":", "_")
                out_path = os.path.join(output_dir, f"{safe_name}.wav")
                with open(out_path, "wb") as f:
                    f.write(wav_data)
                count += 1
    return count


def convert_audio(input_path, target_sample_rate, target_channels, target_bit_depth=16):
    audio = AudioSegment.from_file(input_path)
    audio = audio.set_frame_rate(target_sample_rate)
    audio = audio.set_channels(target_channels)
    audio = audio.set_sample_width(target_bit_depth // 8)
    return audio


def load_input_audio(input_path, target_freq=48000, target_channels=2):
    """Load and resample an input file to the target format. No normalization."""
    return convert_audio(input_path, target_freq, target_channels, 16)


def normalize_pcm16(segment):
    """Normalize an AudioSegment to -29 LUFS via two-pass loudnorm."""
    freq = segment.frame_rate
    channels = segment.channels
    raw_pcm = segment.raw_data

    base_filter = "loudnorm=I=%s:TP=%s:LRA=%s" % (LOUDNORM_I, LOUDNORM_TP, LOUDNORM_LRA)

    result = subprocess.run([
        "ffmpeg", "-y",
        "-f", "s16le", "-ar", str(freq), "-ac", str(channels),
        "-i", "pipe:0",
        "-af", base_filter + ":print_format=json",
        "-f", "null", "NUL"
    ], input=raw_pcm, capture_output=True)

    stderr_text = result.stderr.decode("utf-8", errors="replace")

    measured = {}
    key_map = {"input_i": "I", "input_tp": "TP", "input_lra": "LRA", "input_thresh": "thresh"}
    for json_key, filter_key in key_map.items():
        m = re.search(r'"' + json_key + r'"\s*:\s*"([^"]+)"', stderr_text)
        if m:
            measured[filter_key] = m.group(1)

    linear = "true" if not measured else "false"
    filter_str = base_filter + ":linear=%s" % linear
    if measured:
        for key, val in measured.items():
            filter_str += ":measured_%s=%s" % (key, val)

    result2 = subprocess.run([
        "ffmpeg", "-y",
        "-f", "s16le", "-ar", str(freq), "-ac", str(channels),
        "-i", "pipe:0",
        "-af", filter_str,
        "-f", "s16le", "-ar", str(freq), "-ac", str(channels),
        "pipe:1"
    ], input=raw_pcm, capture_output=True, check=True)

    return AudioSegment(
        data=result2.stdout,
        sample_width=2,
        frame_rate=freq,
        channels=channels,
    )


def loop_segment(audio, target_ms):
    """Truncate or loop an AudioSegment to exactly target_ms duration."""
    if len(audio) >= target_ms:
        return audio[:target_ms]

    full = audio
    result = full
    while len(result) < target_ms:
        result += full
    return result[:target_ms]


def _find_resource_file(env):
    for name, entry in env.file.files.items():
        if name.endswith('.resource'):
            return name, entry
    return None, None


def _build_new_resource(env, res_data, replacements):
    """
    Build a new resource file with replacement FSB5 data for specified clips.
    Returns (new_resource_bytes, list of (clip_obj, new_offset, new_size) updates).
    """
    all_clips = []
    for obj in env.objects:
        if obj.type.name == "AudioClip":
            clip = obj.read()
            if clip.m_Resource:
                all_clips.append((obj, clip))

    all_clips.sort(key=lambda t: t[1].m_Resource.m_Offset)

    new_resource = bytearray()
    new_offset = 0
    updates = []

    for obj, clip in all_clips:
        if clip.m_Name in replacements:
            fsb5_data = replacements[clip.m_Name]
        else:
            off = clip.m_Resource.m_Offset
            sz = clip.m_Resource.m_Size
            fsb5_data = bytes(res_data[off:off + sz])

        new_resource.extend(fsb5_data)
        updates.append((obj, new_offset, len(fsb5_data)))
        new_offset += len(fsb5_data)

    return bytes(new_resource), updates


def _save_bundle(env, bundle_path, new_resource_bytes, updates):
    """Apply updates and save the bundle."""
    res_name, res_entry = _find_resource_file(env)
    if not res_name:
        return False

    new_reader = EndianBinaryReader(new_resource_bytes, endian=res_entry.endian)
    new_reader.flags = 0
    env.file.files[res_name] = new_reader

    for obj, new_offset, new_size in updates:
        clip = obj.read()
        clip.m_Resource.m_Offset = new_offset
        clip.m_Resource.m_Size = new_size
        clip.save()

    bundle_bytes = env.file.save()

    with open(bundle_path, "wb") as f:
        f.write(bundle_bytes)

    return True


def replace_clip(bundle_path, clip_name, input_path, fade=True):
    ensure_backup(bundle_path)
    env = UnityPy.load(bundle_path)

    target_clip = None
    for obj in env.objects:
        if obj.type.name == "AudioClip":
            clip = obj.read()
            if clip.m_Name == clip_name:
                target_clip = clip
                break

    if not target_clip or not target_clip.m_Resource:
        return False

    freq = target_clip.m_Frequency
    channels = target_clip.m_Channels
    num_samples = int(target_clip.m_Length * freq)
    target_ms = int(num_samples * 1000 / freq)
    pcm_size = num_samples * channels * 2

    raw = load_input_audio(input_path, freq, channels)
    segment = loop_segment(raw, target_ms)
    segment = normalize_pcm16(segment)
    if fade:
        segment = segment.fade_out(1500)
    pcm_data = segment.raw_data[:pcm_size]
    if len(pcm_data) < pcm_size:
        pcm_data += b"\x00" * (pcm_size - len(pcm_data))

    new_fsb5 = encode_pcm16_fsb5(pcm_data, num_samples, channels, freq)

    res_name, res_entry = _find_resource_file(env)
    if not res_name:
        return False

    res_data = bytearray(res_entry.bytes)
    replacements = {clip_name: new_fsb5}
    new_resource, updates = _build_new_resource(env, res_data, replacements)

    for obj, _, _ in updates:
        clip = obj.read()
        if clip.m_Name == clip_name:
            clip.m_CompressionFormat = 0
            clip.save()

    return _save_bundle(env, bundle_path, new_resource, updates)


def replace_batch(bundle_path, replacements, fades=None):
    """
    replacements: list of (clip_name, input_path) tuples.
    fades: optional dict mapping clip_name -> bool (default True).
    Replaces all clips in a single pass.
    """
    if fades is None:
        fades = {}
    ensure_backup(bundle_path)
    env = UnityPy.load(bundle_path)

    clip_map = {}
    for obj in env.objects:
        if obj.type.name == "AudioClip":
            clip = obj.read()
            if clip.m_Resource:
                clip_map[clip.m_Name] = (obj, clip)

    for clip_name, _ in replacements:
        if clip_name not in clip_map:
            return False, "Clip not found: %s" % clip_name

    res_name, res_entry = _find_resource_file(env)
    if not res_name:
        return False, "No resource file found"

    res_data = bytearray(res_entry.bytes)

    raw_cache = {}
    fsb5_replacements = {}

    for clip_name, input_path in replacements:
        _, clip = clip_map[clip_name]
        freq = clip.m_Frequency
        channels = clip.m_Channels
        num_samples = int(clip.m_Length * freq)
        target_ms = int(num_samples * 1000 / freq)
        pcm_size = num_samples * channels * 2

        cache_key = (input_path, freq, channels)
        if cache_key not in raw_cache:
            raw_cache[cache_key] = load_input_audio(input_path, freq, channels)

        raw = raw_cache[cache_key]
        segment = loop_segment(raw, target_ms)
        segment = normalize_pcm16(segment)
        if fades.get(clip_name, True):
            segment = segment.fade_out(3000)
        pcm_data = segment.raw_data[:pcm_size]
        if len(pcm_data) < pcm_size:
            pcm_data += b"\x00" * (pcm_size - len(pcm_data))

        fsb5_replacements[clip_name] = encode_pcm16_fsb5(pcm_data, num_samples, channels, freq)

    new_resource, updates = _build_new_resource(env, res_data, fsb5_replacements)

    replaced_names = set(clip_name for clip_name, _ in replacements)
    for obj, _, _ in updates:
        clip = obj.read()
        if clip.m_Name in replaced_names:
            clip.m_CompressionFormat = 0
            clip.save()

    return _save_bundle(env, bundle_path, new_resource, updates), None


def restore_bundle(bundle_path):
    backup = get_backup_path(bundle_path)
    if os.path.exists(backup):
        shutil.copy2(backup, bundle_path)
        return True
    return False


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: audio_handler.py <list|extract|extract-all|replace|replace-batch|restore> [args...]"}))
        sys.exit(1)

    command = sys.argv[1]

    try:
        if command == "list":
            bundle_path = sys.argv[2]
            clips = list_clips(bundle_path)
            print(json.dumps(clips))

        elif command == "extract":
            bundle_path = sys.argv[2]
            clip_name = sys.argv[3]
            output_path = sys.argv[4]
            success = extract_clip(bundle_path, clip_name, output_path)
            print(json.dumps({"success": success}))

        elif command == "extract-all":
            bundle_path = sys.argv[2]
            output_dir = sys.argv[3]
            count = extract_all(bundle_path, output_dir)
            print(json.dumps({"success": True, "count": count}))

        elif command == "replace":
            bundle_path = sys.argv[2]
            clip_name = sys.argv[3]
            input_path = sys.argv[4]
            fade = len(sys.argv) < 6 or sys.argv[5] != "false"
            success = replace_clip(bundle_path, clip_name, input_path, fade)
            print(json.dumps({"success": success}))

        elif command == "replace-batch":
            bundle_path = sys.argv[2]
            replacements_json = sys.argv[3]
            replacements = json.loads(replacements_json)
            fades = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
            success, error = replace_batch(bundle_path, replacements, fades)
            print(json.dumps({"success": success, "error": error}))

        elif command == "restore":
            bundle_path = sys.argv[2]
            success = restore_bundle(bundle_path)
            print(json.dumps({"success": success}))

        elif command == "check-ffmpeg":
            try:
                subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
                print(json.dumps({"available": True}))
            except Exception:
                print(json.dumps({"available": False}))

        else:
            print(json.dumps({"error": f"Unknown command: {command}"}))
            sys.exit(1)

    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e), "trace": traceback.format_exc()}))
        sys.exit(1)


if __name__ == "__main__":
    main()
