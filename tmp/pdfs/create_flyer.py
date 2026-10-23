from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
import os

OUT = "output/pdf/ambassador-jeff-flake-speaking.pdf"
PHOTO = ".next/dev/cache/images/TW-PSft5DnvPdKJicy8_xsW7bnqrgxvq_jobCXcOa9g/14400.1792011936615.DA2onn7A31S8V_fB0xgnM6hegu3ZB5X6y91TbppS_as.IjgxM2JiZTNjMWFlZWM3Yzg1YjM3M2FiZWRlMjllNTFkIg.webp"
SEAL = "public/seal.png"
W, H = letter
PAPER = HexColor("#F4F0E6")
PANEL = HexColor("#FCFAF4")
OXFORD = HexColor("#15233F")
GRAPHITE = HexColor("#262A33")
SLATE = HexColor("#5C606B")
BRASS = HexColor("#93732F")
BRASS_SOFT = HexColor("#B29350")
RULE = HexColor("#D6CDBA")

def wrap(text, font, size, width):
    lines, line = [], ""
    for word in text.split():
        candidate = (line + " " + word).strip()
        if not line or stringWidth(candidate, font, size) <= width:
            line = candidate
        else:
            lines.append(line); line = word
    if line: lines.append(line)
    return lines

def centered_lines(c, text, y, font, size, leading, color, width):
    c.setFillColor(color); c.setFont(font, size)
    for line in wrap(text, font, size, width):
        c.drawCentredString(W / 2, y, line)
        y -= leading
    return y

def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    c = canvas.Canvas(OUT, pagesize=letter)
    c.setTitle("Ambassador Jeff Flake - Speaking Topics")
    c.setAuthor("Jeff Flake")
    c.setSubject("Speaking engagements")

    # Site-inspired base: warm parchment, Oxford navy, restrained brass.
    c.setFillColor(PAPER); c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(OXFORD); c.rect(0, H-104, W, 104, stroke=0, fill=1)
    c.setFillColor(BRASS_SOFT); c.rect(0, H-104, W, 4, stroke=0, fill=1)

    # Branded masthead.
    c.drawImage(ImageReader(SEAL), 71, H-74, 49, 49, mask="auto")
    c.setFillColor(BRASS_SOFT); c.setFont("Helvetica-Bold", 7.5)
    c.drawString(140, H-34, "S P E A K I N G   E N G A G E M E N T S")
    c.setFillColor(white); c.setFont("Times-Bold", 27)
    c.drawString(140, H-67, "Ambassador Jeff Flake")
    c.setStrokeColor(BRASS_SOFT); c.setLineWidth(.7); c.line(140, H-80, 448, H-80)

    # Portrait begins below the condensed masthead, leaving the header fully clear.
    frame_x, frame_y, frame_w, frame_h = 240, 500, 132, 155
    c.setFillColor(PANEL); c.roundRect(frame_x-5, frame_y-5, frame_w+10, frame_h+10, 2, stroke=0, fill=1)
    c.setStrokeColor(BRASS); c.setLineWidth(.8); c.rect(frame_x, frame_y, frame_w, frame_h, stroke=1, fill=0)
    c.saveState()
    path = c.beginPath(); path.rect(frame_x, frame_y, frame_w, frame_h)
    c.clipPath(path, stroke=0, fill=0)
    c.drawImage(ImageReader(PHOTO), 200, frame_y, width=207, height=frame_h, preserveAspectRatio=True, anchor="n", mask="auto")
    c.restoreState()

    bio = ("Former U.S. Senator and Congressman. Most recently, U.S. Ambassador to Turkiye "
           "(2021-2024).")
    centered_lines(c, bio, 483, "Helvetica", 9.7, 13.2, GRAPHITE, 440)

    # Keep the exact, successful topic structure; use one clear section label.
    c.setFillColor(OXFORD); c.setFont("Times-Bold", 19)
    c.drawCentredString(W/2, 447, "Speaking Topics")
    c.setStrokeColor(RULE); c.setLineWidth(.65); c.line(152, 431, 460, 431)

    topics = [
        "No Man is an Island",
        "From Washington to Istanbul",
        "Diplomats Wanted",
        "Leading with Civility",
        "The World Needs Leaders",
        "Bridging America's Divides",
        "Public Service is a Noble Profession",
    ]
    row_top = 431
    row_height = 29
    for index, title in enumerate(topics):
        # Baseline is optically centered inside an equal-height band.
        y = row_top - index * row_height - 18
        c.setFillColor(OXFORD); c.setFont("Times-Bold", 12.5)
        c.drawCentredString(W/2, y, title)
        divider_y = row_top - (index + 1) * row_height
        c.setStrokeColor(RULE); c.setLineWidth(.35); c.line(259, divider_y, 353, divider_y)

    # Two concise endorsements, with the quotation marks held close to the text.
    c.setFillColor(PANEL); c.roundRect(84, 80, 444, 140, 4, stroke=0, fill=1)
    c.setStrokeColor(RULE); c.setLineWidth(.5); c.roundRect(84, 80, 444, 140, 4, stroke=1, fill=0)
    lake_quote = "“Ambassador Flake's ability to speak to ALL people in that room is a gift and an example of true leadership.”"
    centered_lines(c, lake_quote, 198, "Times-Italic", 9.7, 11.5, GRAPHITE, 340)
    c.setFillColor(BRASS); c.setFont("Helvetica-Bold", 7.2)
    c.drawCentredString(W/2, 166, "L A K E  F O R E S T  C O L L E G E")
    c.setStrokeColor(RULE); c.setLineWidth(.35); c.line(160, 147, 452, 147)
    emory_quote = ("“It's not every day you get to talk to a former senator and ambassador to Turkey. "
                   "He's very conversational and took a lot of interest in our lives and priorities as students.”")
    centered_lines(c, emory_quote, 129, "Times-Italic", 8.7, 10.5, GRAPHITE, 345)
    c.setFillColor(BRASS); c.setFont("Helvetica-Bold", 7.2)
    c.drawCentredString(W/2, 98, "E M O R Y  U N I V E R S I T Y  S T U D E N T")

    c.setStrokeColor(RULE); c.setLineWidth(.65); c.line(180, 52, 432, 52)
    c.setFillColor(BRASS); c.setFont("Helvetica-Bold", 6.8)
    c.drawCentredString(W/2, 34, "S P E A K I N G   I N Q U I R I E S")
    c.setFillColor(OXFORD); c.setFont("Helvetica", 8.9)
    c.drawCentredString(W/2, 16, "jeffflake.com   |   cheryl@jeffflake.com")
    c.showPage(); c.save()

if __name__ == "__main__": main()
