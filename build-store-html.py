#!/usr/bin/env python3
"""Render STORE_DESCRIPTION.txt into the HTML subset the Onshape dev portal allows.

The Description field permits only:
  a b blockquote br cite code dd dl dt em i li ol p pre q small span
  strike strong sub sup u ul
No headings and no table, so ALL-CAPS lines become <p><b>...</b></p> and every
aligned block becomes <pre>, which is also the cheapest way to keep the columns
lined up. The field caps at 10000 characters and markup counts, so blocks are
joined without newlines -- outside <pre> the HTML does not need them, and it
makes the count independent of CRLF translation.
"""
import io, re, sys

esc = lambda t: (t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                  .replace("—", "&mdash;"))   # pure ASCII out, no encoding risk
lines = io.open("STORE_DESCRIPTION.txt", encoding="utf-8").read().split("\n")
out, para, pre, bullet = [], [], [], []

def flush_para():
    if para: out.append("<p>" + esc(" ".join(para)) + "</p>"); para.clear()
def flush_pre():
    while pre and not pre[-1].strip(): pre.pop()
    if pre: out.append("<pre>" + esc("\n".join(pre)) + "</pre>"); pre.clear()
def flush_bullet():
    if bullet:
        out.append("<ul>" + "".join("<li>" + esc(b) + "</li>" for b in bullet) + "</ul>")
        bullet.clear()

i = 0
while i < len(lines):
    ln = lines[i]
    if ln.strip() and ln.isupper() and not ln[:1].isspace():
        flush_para(); flush_pre(); flush_bullet()
        # <br> opens a little air before each section; the portal allows no
        # heading tags and no <hr>, so this is the separator available. The
        # leading newline is only for the paste box -- HTML ignores it.
        lead = "" if not out else "\n<br>"
        out.append(lead + "<p><b>" + esc(ln.strip()) + "</b></p>")
    elif ln.startswith("  - "):
        flush_para(); flush_pre()
        item = [ln[4:].strip()]
        while i + 1 < len(lines) and lines[i+1].startswith("    ") and not lines[i+1].startswith("  - "):
            i += 1; item.append(lines[i].strip())
        bullet.append(" ".join(item))
    elif ln[:1].isspace() and ln.strip():
        flush_para(); flush_bullet(); pre.append(ln)
    elif not ln.strip():
        flush_para(); flush_bullet()
        if pre: pre.append(ln)
    else:
        flush_pre(); flush_bullet(); para.append(ln.strip())
    i += 1
flush_para(); flush_pre(); flush_bullet()

html = "".join(out)
io.open("STORE_DESCRIPTION.html", "w", encoding="utf-8", newline="\n").write(html)

ALLOWED = {"a","b","blockquote","br","cite","code","dd","dl","dt","em","i","li",
           "ol","p","pre","q","small","span","strike","strong","sub","sup","u","ul"}
used = set(re.findall(r"</?([a-z]+)", html))
bad = used - ALLOWED
print(f"characters {len(html)}  headroom {10000 - len(html)}")
print("tags used :", " ".join(sorted(used)))
if bad: print("DISALLOWED:", " ".join(sorted(bad))); sys.exit(1)
if len(html) > 10000: print("OVER THE 10000 LIMIT"); sys.exit(1)
assert all(ord(c) < 128 for c in html), "non-ASCII survived"
print("within the limit, all tags allowed, pure ASCII")
