import json

from openai import OpenAI

from app.config import OPENAI_API_KEY, OPENAI_MODEL


def available() -> bool:
    return bool(OPENAI_API_KEY)


def ask_json(system: str, user: str, model: str | None = None) -> dict:
    client = OpenAI(api_key=OPENAI_API_KEY, timeout=60)
    response = client.chat.completions.create(
        model=model or OPENAI_MODEL,
        response_format={"type": "json_object"},
        temperature=0.3,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
    )
    return json.loads(response.choices[0].message.content)
