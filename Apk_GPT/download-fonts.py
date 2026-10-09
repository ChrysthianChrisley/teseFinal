"""Fetch the site's existing Google Fonts once, for offline packaging."""
from pathlib import Path
import re
import urllib.request

directory = Path(__file__).resolve().parent / 'web' / 'fonts'
directory.mkdir(parents=True, exist_ok=True)
url = 'https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap'
css = urllib.request.urlopen(url, timeout=30).read().decode('utf-8')
downloaded = {}
def fetch(match):
    source = match.group(1)
    if source not in downloaded:
        if not source.startswith('https://fonts.gstatic.com/'):
            raise ValueError('Unexpected font source')
        filename = f'font-{len(downloaded)+1}.ttf'
        (directory / filename).write_bytes(urllib.request.urlopen(source, timeout=30).read())
        downloaded[source] = filename
    return f'url({downloaded[source]})'
css = re.sub(r'url\((https://[^)]+)\)', fetch, css)
(directory / 'fonts.css').write_text(css, encoding='utf-8')
print(f'{len(downloaded)} font files saved for offline use.')
