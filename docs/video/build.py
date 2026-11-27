# Stitches the captured scenes into a 1280x720 MP4 with captions (ffmpeg drawtext).
import json, os, subprocess, textwrap, sys

HERE = os.path.dirname(os.path.abspath(__file__))
FR = os.path.join(HERE, 'frames')
OUT = sys.argv[1]
FONT = 'C\\:/Windows/Fonts/segoeui.ttf'
FONTB = 'C\\:/Windows/Fonts/segoeuib.ttf'
BG = '0x101410'
LF = chr(10)

scenes = json.load(open(os.path.join(FR, 'scenes.json'), encoding='utf-8'))
clips = []

def wrap(text, width):
    lines = []
    for para in text.split(LF):
        lines += textwrap.wrap(para, width) or ['']
    return LF.join(lines)

def write(path, text):
    # drawtext treats CR as a line break: write LF-only files on Windows
    with open(path, 'w', encoding='utf-8', newline=LF) as f:
        f.write(text)

def esc_path(p):
    return p.replace('\\', '/').replace(':', '\\:')

for i, s in enumerate(scenes):
    clip = os.path.join(FR, f'clip{i:02d}.mp4')
    capfile = os.path.join(FR, f'cap{i:02d}.txt')
    secs = str(s['secs'])
    if s['kind'] == 'title':
        lines = s['caption'].split(LF)
        headfile = capfile + '.h'
        write(headfile, lines[0])
        write(capfile, wrap(LF.join(lines[1:]).strip(LF), 64))
        vf = (f"drawtext=fontfile='{FONTB}':textfile='{esc_path(headfile)}':fontcolor=0x7CFC8A:fontsize=64:x=(w-tw)/2:y=150,"
              f"drawtext=fontfile='{FONT}':textfile='{esc_path(capfile)}':fontcolor=0xE5E5E5:fontsize=30:line_spacing=14:x=(w-tw)/2:y=270")
        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', f'color=c={BG}:s=1280x720:d={secs}:r=30', '-vf', vf,
               '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]
    else:
        write(capfile, wrap(s['caption'], 96))
        if s['kind'] == 'glasses':
            scale, xy, tag = 'scale=1000:500:flags=neighbor', '140:10', 'Even G2 lens · official Even Hub simulator'
        else:
            scale, xy, tag = 'scale=1120:504', '80:8', 'Telegram (owner fallback + audit) · @restu_glasses_bot'
        tagfile = capfile + '.t'
        write(tagfile, tag)
        fc = (f"[1:v]{scale}[img];[0:v][img]overlay={xy}[v0];"
              f"[v0]drawtext=fontfile='{FONT}':textfile='{esc_path(tagfile)}':fontcolor=0x8A8A8A:fontsize=16:x=w-tw-16:y=518,"
              f"drawtext=fontfile='{FONT}':textfile='{esc_path(capfile)}':fontcolor=0xF2F2F2:fontsize=22:line_spacing=8:x=40:y=548[v]")
        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', f'color=c={BG}:s=1280x720:d={secs}:r=30',
               '-loop', '1', '-t', secs, '-i', s['file'], '-filter_complex', fc, '-map', '[v]', '-t', secs,
               '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', clip]
    subprocess.run(cmd, check=True)
    clips.append(clip)

lst = os.path.join(FR, 'list.txt')
write(lst, ''.join(f"file '{c.replace(os.sep, '/')}'{LF}" for c in clips))
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', '-movflags', '+faststart', OUT], check=True)
total = sum(float(s['secs']) for s in scenes)
print(f'wrote {OUT} ({total:.0f}s, {len(clips)} scenes)')
