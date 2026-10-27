from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / 'static/portfolio/assets/stickers'
SCALE = 3
INK = '#382D2B'
YELLOW = '#FFD34F'
RED = '#EF6470'
BLUE = '#44A6E8'
WHITE = '#FFFDF3'


def draw_sticker(kind):
    image = Image.new('RGBA', (128 * SCALE, 128 * SCALE))
    pen = ImageDraw.Draw(image)

    def box(values):
        return tuple(round(value * SCALE) for value in values)

    def ellipse(values, fill, outline=None, width=1):
        pen.ellipse(box(values), fill=fill, outline=outline, width=round(width * SCALE))

    def line(points, fill=INK, width=5):
        points = [(round(x * SCALE), round(y * SCALE)) for x, y in points]
        pen.line(points, fill=fill, width=round(width * SCALE), joint='curve')
        radius = width * SCALE / 2
        for x, y in [points[0], points[-1]]:
            pen.ellipse((x-radius, y-radius, x+radius, y+radius), fill=fill)

    def arc(values, start, end, fill=INK, width=5):
        pen.arc(box(values), start=start, end=end, fill=fill, width=round(width * SCALE))

    def poly(points, fill, outline=None, width=1):
        scaled = [(round(x * SCALE), round(y * SCALE)) for x, y in points]
        pen.polygon(scaled, fill=fill)
        if outline:
            pen.line(scaled + [scaled[0]], fill=outline, width=round(width * SCALE), joint='curve')

    def round_rect(values, radius, fill, outline=None, width=1):
        pen.rounded_rectangle(box(values), radius=round(radius*SCALE), fill=fill, outline=outline, width=round(width*SCALE))

    def curve(start, segments, fill=None, outline=None, width=4):
        points = [start]
        for x1, y1, x2, y2, x3, y3 in segments:
            x0, y0 = points[-1]
            for step in range(1, 25):
                t = step / 24
                u = 1 - t
                points.append((u**3*x0 + 3*u*u*t*x1 + 3*u*t*t*x2 + t**3*x3,
                               u**3*y0 + 3*u*u*t*y1 + 3*u*t*t*y2 + t**3*y3))
        if fill:
            poly(points, fill)
        if outline:
            line(points, outline, width)

    def heart(x, y, size):
        segments = [(.30, -.03, -.06, .07, .05, .40),
                    (.11, .61, .33, .79, .50, .96),
                    (.67, .79, .89, .61, .95, .40),
                    (1.06, .07, .70, -.03, .50, .24)]
        curve((x+size*.5, y+size*.24),
              [tuple((x if i % 2 == 0 else y) + size*v for i, v in enumerate(segment))
               for segment in segments], fill=RED)

    def eye(x, y=43):
        ellipse((x-5, y, x+5, y+18), INK)

    def smile():
        arc((39, 57, 89, 90), 5, 175, width=6)

    if kind == 'doge':
        curve((15, 57), [(11, 43, 13, 22, 16, 8), (17, 5, 20, 6, 24, 11),
                        (32, 20, 37, 25, 43, 29), (56, 24, 72, 24, 85, 29),
                        (92, 20, 101, 12, 108, 7), (111, 5, 113, 7, 113, 12),
                        (116, 30, 118, 43, 114, 57), (119, 80, 112, 100, 94, 111),
                        (77, 122, 50, 122, 32, 112), (14, 102, 8, 80, 15, 57)],
              fill='#DFA45D', outline=INK)
        curve((22, 18), [(24, 19, 31, 28, 34, 33), (29, 33, 25, 35, 21, 38),
                        (20, 31, 20, 23, 22, 18)], fill='#80553B')
        curve((106, 18), [(108, 23, 108, 31, 107, 38), (103, 35, 99, 33, 94, 33),
                         (97, 28, 104, 19, 106, 18)], fill='#80553B')
        curve((22, 75), [(26, 68, 38, 68, 43, 69), (49, 61, 60, 59, 65, 64),
                        (71, 59, 82, 63, 88, 69), (94, 68, 102, 69, 107, 76),
                        (110, 93, 98, 109, 81, 114), (62, 120, 37, 112, 28, 99),
                        (23, 91, 20, 83, 22, 75)], fill='#FFF0C8')
    elif kind == 'melt':
        curve((64, 13), [(90, 13, 110, 30, 110, 58), (110, 75, 104, 80, 108, 90),
                        (110, 96, 120, 96, 121, 104), (124, 112, 109, 116, 96, 114),
                        (88, 113, 90, 120, 76, 120), (62, 120, 61, 112, 52, 114),
                        (40, 118, 32, 121, 25, 115), (21, 112, 8, 116, 7, 107),
                        (6, 100, 21, 100, 24, 90), (27, 80, 19, 70, 19, 57),
                        (19, 32, 38, 13, 64, 13)], fill=YELLOW, outline=INK)
    else:
        ellipse((12, 12, 116, 116), '#F98175' if kind == 'angry' else YELLOW, INK, 4)

    if kind == 'happy':
        eye(43)
        eye(85)
        arc((35, 57, 93, 95), 0, 180, width=7)
        ellipse((23, 65, 39, 74), '#F59D72')
        ellipse((89, 65, 105, 74), '#F59D72')
    elif kind == 'laugh':
        line([(32, 47), (45, 55), (32, 62)])
        line([(96, 47), (83, 55), (96, 62)])
        round_rect((38, 69, 90, 99), 13, INK)
        round_rect((43, 71, 85, 80), 3, WHITE)
        ellipse((52, 86, 78, 101), RED)
        poly([(14,56),(3,75),(8,84),(18,83),(23,75)], BLUE)
        poly([(114,56),(105,75),(110,84),(120,83),(125,75)], BLUE)
    elif kind == 'cry':
        line([(31, 45), (48, 41)], width=5)
        line([(80, 41), (97, 45)], width=5)
        line([(30, 57), (50, 57)], width=6)
        line([(78, 57), (98, 57)], width=6)
        round_rect((32, 61, 47, 108), 6, BLUE)
        round_rect((81, 61, 96, 108), 6, BLUE)
        line([(36, 67), (36, 98)], fill='#B8E8FA', width=3)
        line([(85, 67), (85, 98)], fill='#B8E8FA', width=3)
        arc((47, 77, 81, 103), 180, 360, width=6)
    elif kind == 'angry':
        line([(28, 39), (51, 49)], width=7)
        line([(77, 49), (100, 39)], width=7)
        eye(43, 53)
        eye(85, 53)
        arc((43, 81, 85, 101), 185, 355, width=6)
        line([(104, 12), (104, 19), (97, 19)], fill=RED, width=5)
        line([(113, 12), (113, 19), (120, 19)], fill=RED, width=5)
        line([(104, 35), (104, 28), (97, 28)], fill=RED, width=5)
        line([(113, 35), (113, 28), (120, 28)], fill=RED, width=5)
    elif kind == 'wow':
        ellipse((28, 38, 53, 68), WHITE, INK, 3)
        ellipse((75, 38, 100, 68), WHITE, INK, 3)
        ellipse((38, 47, 47, 61), INK)
        ellipse((81, 47, 90, 61), INK)
        ellipse((52, 75, 76, 103), INK)
    elif kind == 'love':
        heart(24, 36, 33)
        heart(71, 36, 33)
        arc((41, 70, 87, 98), 0, 180, width=6)
    elif kind == 'like':
        eye(42)
        eye(80)
        arc((34, 62, 83, 94), 5, 175, width=6)
        poly([(90,91),(90,74),(99,61),(100,46),(107,45),(112,52),(110,67),(121,68),(124,75),(118,100),(102,101)], '#FFD1A0', INK, 3)
        round_rect((85, 86, 100, 105), 2, '#4F9DE1', INK, 3)
    elif kind == 'sleepy':
        arc((28, 41, 53, 62), 0, 180, width=5)
        arc((75, 41, 100, 62), 0, 180, width=5)
        ellipse((53, 76, 75, 92), INK)
        ellipse((70, 85, 82, 104), '#86CCE9')
        ellipse((101, 4, 122, 25), '#8F86C4')
        ellipse((95, 0, 115, 21), '#00000000')
    elif kind == 'confused':
        line([(29, 39), (50, 33)], width=5)
        arc((77, 34, 99, 45), 180, 360, width=5)
        eye(42, 49)
        eye(87, 49)
        line([(46, 86), (61, 81), (77, 88)], width=5)
        arc((103, 3, 121, 20), 185, 445, '#8C72C2', 5)
        line([(111, 21), (109, 25)], fill='#8C72C2', width=4)
        ellipse((107, 32, 112, 37), '#8C72C2')
    elif kind == 'awkward':
        eye(42, 46)
        eye(84, 46)
        round_rect((37, 80, 91, 96), 5, WHITE, INK, 3)
        for x in (49, 64, 79):
            line([(x, 83), (x, 93)], width=2)
        poly([(104,27),(93,46),(96,55),(107,59),(116,52),(116,44)], BLUE)
    elif kind == 'fish':
        round_rect((25, 41, 59, 63), 6, INK)
        round_rect((69, 41, 103, 63), 6, INK)
        line([(59, 47), (69, 47)], width=5)
        line([(29, 44), (37, 44)], fill=WHITE, width=3)
        line([(73, 44), (81, 44)], fill=WHITE, width=3)
        smile()
        poly([(91,91),(115,78),(115,110)], BLUE, INK, 2)
        ellipse((41, 86, 99, 114), BLUE, INK, 3)
        ellipse((50, 95, 57, 102), INK)
        arc((61, 90, 83, 110), 275, 85, '#C8F0FF', 3)
    elif kind == 'coffee':
        line([(27, 51), (49, 55)], width=5)
        line([(79, 55), (101, 51)], width=5)
        ellipse((38, 56, 45, 64), INK)
        ellipse((83, 56, 90, 64), INK)
        line([(49, 79), (79, 79)], width=5)
        arc((88, 83, 113, 111), 270, 90, INK, 6)
        round_rect((49, 83, 97, 118), 8, WHITE, INK, 3)
        ellipse((51, 84, 95, 94), '#A86B40', INK, 2)
        line([(60, 75), (57, 70), (61, 65)], fill='#D2DDE3', width=4)
        line([(79, 75), (76, 70), (80, 65)], fill='#D2DDE3', width=4)
    elif kind == 'melt':
        curve((31, 47), [(37, 51, 44, 53, 50, 51)], outline=INK, width=6)
        curve((78, 51), [(84, 53, 91, 51, 97, 47)], outline=INK, width=6)
        curve((45, 73), [(54, 87, 75, 89, 86, 72)], outline=INK, width=5)
    elif kind == 'broken':
        line([(31, 44), (47, 60)], width=5)
        line([(47, 44), (31, 60)], width=5)
        line([(81, 44), (97, 60)], width=5)
        line([(97, 44), (81, 60)], width=5)
        line([(40, 85), (51, 79), (64, 87), (77, 79), (88, 85)], width=5)
        line([(68, 13), (58, 28), (69, 39), (60, 54), (68, 69), (60, 83), (67, 99), (60, 115)], fill='#BC8136', width=4)
    elif kind == 'party':
        poly([(33, 37),(61, 1),(86, 37)], '#8F75C9', INK, 3)
        line([(47, 21),(72, 21)], fill='#F69BA0', width=6)
        round_rect((29, 34, 89, 43), 3, '#F69BA0', INK, 2)
        arc((27, 51, 49, 67), 185, 355, width=5)
        arc((78, 51, 100, 67), 185, 355, width=5)
        arc((37, 65, 91, 97), 0, 180, width=6)
        for values, color in [((7,22,12,29), RED),((103,9,108,16),BLUE),((117,38,122,45),'#8F75C9'),((3,68,8,75),BLUE)]:
            round_rect(values, 1, color)
    elif kind == 'okay':
        eye(40)
        arc((74, 44, 96, 60), 0, 180, width=5)
        smile()
        ellipse((86, 83, 125, 122), '#69BB84', INK, 3)
        line([(95,102),(102,109),(117,94)], fill=WHITE, width=5)
    elif kind == 'doge':
        ellipse((27, 45, 52, 63), WHITE, INK, 2)
        ellipse((77, 45, 102, 63), WHITE, INK, 2)
        ellipse((42, 48, 50, 60), INK)
        ellipse((92, 48, 100, 60), INK)
        line([(27, 46), (51, 49)], width=4)
        line([(77, 46), (101, 49)], width=4)
        curve((56, 69), [(59, 66, 70, 66, 75, 69), (75, 74, 70, 79, 65, 80),
                        (60, 79, 55, 74, 56, 69)], fill=INK)
        ellipse((58, 68, 66, 71), '#75625A')
        line([(65, 79), (65, 91)], width=3)
        curve((42, 87), [(53, 96, 80, 96, 94, 83)], outline=INK, width=4)
        curve((91, 81), [(94, 81, 97, 82, 98, 85)], outline=INK, width=3)

    image = image.resize((128, 128), Image.Resampling.LANCZOS)
    return image.quantize(colors=96, method=Image.Quantize.FASTOCTREE)


KINDS = ['happy', 'laugh', 'cry', 'angry', 'wow', 'love', 'like', 'sleepy',
         'confused', 'awkward', 'fish', 'coffee', 'melt', 'broken', 'party', 'okay', 'doge']
DESTINATION.mkdir(parents=True, exist_ok=True)
sheet = Image.new('RGBA', (640, ((len(KINDS) + 3) // 4) * 160), '#F3F4EF')
total = 0
for index, kind in enumerate(KINDS):
    sticker = draw_sticker(kind)
    destination = DESTINATION / f'{kind}.png'
    sticker.save(destination, optimize=True)
    total += destination.stat().st_size
    sheet.alpha_composite(sticker.convert('RGBA'), (index % 4 * 160 + 16, index // 4 * 160 + 16))
    print(f'{kind}: {destination.stat().st_size} bytes')
sheet.save('/tmp/gavin-sync-stickers-clear.png')
print(f'{len(KINDS)} stickers: {total} bytes; contact sheet: /tmp/gavin-sync-stickers-clear.png')
