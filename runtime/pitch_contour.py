#!/usr/bin/env python
# 用 Praat PSOLA 改「音高曲线」，不改共振峰/音色。
# 用法: python pitch_contour.py in.wav [splitRatio] [semitones|auto]
import sys
import numpy as np
import parselmouth
from parselmouth.praat import call


def median_f0(sound, t0, t1):
    part = sound.extract_part(from_time=t0, to_time=t1, preserve_times=False)
    pitch = part.to_pitch(time_step=0.01, pitch_floor=75, pitch_ceiling=600)
    vals = pitch.selected_array['frequency']
    vals = vals[vals > 0]
    return float(np.median(vals)) if len(vals) else 0.0


def main():
    path = sys.argv[1]
    full_mode = len(sys.argv) > 2 and sys.argv[2] == 'full'
    split_ratio = 1.0 if full_mode else (float(sys.argv[2]) if len(sys.argv) > 2 else 0.5)
    semis_arg = sys.argv[3] if len(sys.argv) > 3 else 'auto'

    sound = parselmouth.Sound(path)
    dur = sound.get_total_duration()
    split = dur * split_ratio

    if full_mode:
        semis = float(semis_arg)
    elif semis_arg == 'auto':
        head = median_f0(sound, 0.0, split)
        tail = median_f0(sound, split, dur)
        if head > 0 and tail > 0:
            factor = (head * 0.90) / tail
            semis = max(-6.0, min(0.0, 12.0 * np.log2(factor)))
        else:
            semis = -2.5
    else:
        semis = float(semis_arg)

    manip = call(sound, "To Manipulation", 0.01, 75, 600)
    tier = call(manip, "Extract pitch tier")
    n = int(call(tier, "Get number of points"))
    factor_end = 2 ** (semis / 12.0)

    new_tier = call("Create PitchTier", "contour", 0.0, dur)
    for i in range(1, n + 1):
        t = call(tier, "Get time from index", i)
        f = call(tier, "Get value at time", t)
        if not f or f <= 0:
            continue
        if full_mode:
            f = f * factor_end
        elif t >= split:
            k = 1.0 + (factor_end - 1.0) * min(1.0, (t - split) / max(1e-6, dur - split))
            f = f * k
        call(new_tier, "Add point", t, f)

    call([manip, new_tier], "Replace pitch tier")
    res = call(manip, "Get resynthesis (overlap-add)")
    res.save(path, "WAV")
    print("semis=%.2f head=%.0f tail=%.0f" % (semis, median_f0(sound, 0.0, split), median_f0(sound, split, dur)))


if __name__ == "__main__":
    main()
