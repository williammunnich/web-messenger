"""The notification sounds, synthesized from scratch (no samples, so no licensing questions).

Style: the soft "bloop" pop that chat widgets commonly use. A pop is a pure sine whose pitch glides quickly
upward (a bubble), with a fast attack and a short, rounded decay. There's no ringing bell harmonics: those made
the first version sound like a slot machine.

  visit.*     one small, quiet pop: someone opened the site
  message.*   two quick pops, then a third, played loud: someone wrote to you. Loud on purpose, but
              short (0.55 s) and soft-edged, so it's hard to miss without being grating.
  message-b.* / message-c.*   alternatives to compare (afplay message-b.caf); copy one over message.* to switch.
Run: python3 make_sounds.py   (it writes WAV files; turn each into the CAF the app uses with
     afconvert -f caff -d LEI16 message.wav message.caf).

@file make_sounds.py
@project web-messenger
@author Claude (Anthropic), written for and prompted by William Munnich
@date Last edited 2026-11-14
"""
import math, struct, wave

RATE = 44100


def pop(t, f0, f1, glide=0.035, decay=28.0, body=0.25):
    """One bubble pop at time t (seconds since it started): pitch slides f0 -> f1 over `glide` seconds.

    @param t: time in seconds since the pop started; before 0 the pop is silent
    @param f0: starting pitch in Hz
    @param f1: final pitch in Hz
    @param glide: seconds the pitch takes to slide from f0 to f1
    @param decay: how fast the pop fades (larger is shorter)
    @param body: amount of the sub-octave tone mixed in
    @return: the sample value at time t
    """
    if t < 0:
        return 0.0
    # phase of an exponential glide, integrated so the sweep is smooth
    if t < glide:
        k = math.log(f1 / f0) / glide
        phase = 2 * math.pi * f0 * (math.exp(k * t) - 1) / k
    else:
        k = math.log(f1 / f0) / glide
        phase = 2 * math.pi * f0 * (math.exp(k * glide) - 1) / k + 2 * math.pi * f1 * (t - glide)
    env = min(1.0, t / 0.004) * math.exp(-t * decay)              # 4 ms attack: no click; then a rounded fade
    return env * (math.sin(phase) + body * math.sin(phase / 2))   # a little sub-octave "body" so it isn't thin


def render(events, length, peak):
    """Mix a list of pops into one sound, saturate it gently, fade out the last 10 ms and scale it to a peak level.

    @param events: one tuple per pop: (start seconds, f0, f1, glide, decay, amplitude)
    @param length: length of the sound in seconds
    @param peak: loudest sample value in the result, from 0 to 1
    @return: the samples as a list of floats
    """
    n = int(RATE * length)
    out = [sum(amp * pop(i / RATE - start, f0, f1, glide, decay) for start, f0, f1, glide, decay, amp in events) for i in range(n)]
    out = [math.tanh(1.6 * x) for x in out]                       # gentle saturation: louder on a phone speaker, no harshness
    m = max(abs(x) for x in out) or 1
    fade = int(0.01 * RATE)
    for i in range(fade):
        out[-1 - i] *= i / fade
    return [x / m * peak for x in out]


def save(name, samples):
    """Write samples as a mono 16-bit WAV file in the current folder.

    @param name: file name without the .wav extension
    @param samples: sample values from -1 to 1 (values outside are clipped)
    """
    with wave.open(name + '.wav', 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, x)) * 32767)) for x in samples))


#          start  from   to     glide  decay  amp
save('visit', render([(0.00, 520, 980, 0.030, 32, 1.0)], 0.22, 0.35))                     # one small pop, quiet

save('message', render([(0.00, 480, 920, 0.035, 26, 1.0),                                # "bloop-bloop … bloop"
                        (0.13, 640, 1230, 0.035, 26, 0.95),
                        (0.30, 700, 1380, 0.040, 20, 0.9)], 0.62, 0.97))

save('message-b', render([(0.00, 420, 860, 0.040, 22, 1.0),                              # two pops, rounder
                          (0.16, 560, 1140, 0.040, 20, 1.0)], 0.55, 0.97))

save('message-c', render([(0.00, 900, 1500, 0.025, 30, 1.0),                             # brighter "pip-pip"
                          (0.11, 900, 1500, 0.025, 30, 1.0),
                          (0.32, 1000, 1700, 0.025, 24, 0.9)], 0.60, 0.97))
print('ok')
