import base64

from openai import OpenAI

from app.config import OPENAI_API_KEY, OPENAI_IMAGE_MODEL

# The image models only make a few fixed sizes; the clip is cropped to the chosen ratio afterwards.
IMAGE_SIZES = {
    "9:16": "1024x1536",
    "4:5": "1024x1536",
    "1:1": "1024x1024",
    "16:9": "1536x1024",
}

# Lyrics are drawn on top by the app, so the picture itself must not contain any text.
STYLE = (
    "Background artwork for a music video. No text, no letters, no numbers, no logos, no watermark. "
    "Keep the composition calm so lyrics stay readable on top. "
)


def generate(prompt: str, aspect: str) -> bytes:
    """One low-quality image (the cheapest setting) as JPEG bytes."""
    client = OpenAI(api_key=OPENAI_API_KEY, timeout=120)
    result = client.images.generate(
        model=OPENAI_IMAGE_MODEL,
        prompt=STYLE + prompt,
        size=IMAGE_SIZES.get(aspect, "1024x1536"),
        quality="low",
        output_format="jpeg",
        n=1,
    )
    return base64.b64decode(result.data[0].b64_json)
