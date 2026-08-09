"""Local-only proxy for Naver Blog Assistant's Ollama requests."""

import json
import os
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HOST = "127.0.0.1"
PORT = 8765
MAX_POST_CHARACTERS = 12000
OLLAMA_API_URL = os.environ.get("OLLAMA_API_URL", "http://127.0.0.1:11434/api/generate")
MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:4b")
DRAFT_RESPONSE_FORMAT = {
    "type": "object",
    "properties": {
        "drafts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "comment": {"type": "string"},
                    "evidence": {"type": "string"},
                },
                "required": ["comment", "evidence"],
                "additionalProperties": False,
            },
            "minItems": 2,
            "maxItems": 2,
        }
    },
    "required": ["drafts"],
    "additionalProperties": False,
}


def make_drafts(title, text):
    prompt = f"""/no_think
다음 네이버 블로그 글을 읽고, 글쓴이에게 남길 자연스러운 한국어 댓글 초안 2개를 작성하세요.

규칙:
- 각각 한두 문장으로 씁니다.
- 글의 제목·본문에 실제로 나온 고유명사, 음식명, 장소, 연도, 가격 중 하나를 정확히 언급합니다.
- 예의 바르고 진솔한 감상을 씁니다.
- 방문 요청, 자기 홍보, 복붙 문구, 과장된 칭찬, 해시태그, 이모지는 쓰지 않습니다.
- 본문에 없는 기간, 숫자, 사건, 성과, 경험을 추측하거나 만들어 내지 않습니다.
- "이 과정", "노력", "성과"처럼 글의 구체적 대상이 드러나지 않는 표현은 쓰지 않습니다.
- 각 댓글에는 본문에서 복사한 두 글자 이상의 구체적인 문구를 반드시 그대로 포함합니다.
- 글을 분석하거나 작성 과정을 설명하지 않습니다.
- 응답은 반드시 `{{"drafts":[{{"comment":"댓글","evidence":"댓글에 포함된 본문 원문"}},{{"comment":"댓글","evidence":"댓글에 포함된 본문 원문"}}]}}` 형태의 JSON만 반환합니다.

글 제목: {title[:300]}
글 본문:
{text[:MAX_POST_CHARACTERS]}"""
    request_body = json.dumps({
        "model": MODEL,
        "prompt": prompt,
        "stream": False,
        "think": False,
        "format": DRAFT_RESPONSE_FORMAT,
        "options": {
            "temperature": 0.2,
            "num_predict": 300,
        },
    }).encode("utf-8")
    request = Request(
        OLLAMA_API_URL,
        data=request_body,
        method="POST",
        headers={
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Ollama 요청이 실패했습니다 ({error.code}): {details}") from error
    except URLError as error:
        raise RuntimeError(
            "Ollama 서버에 연결하지 못했습니다. Ollama를 설치하고 모델을 내려받았는지 확인하세요."
        ) from error

    output = str(payload.get("response", "")).strip()
    try:
        response_data = json.loads(output)
    except json.JSONDecodeError as error:
        raise RuntimeError("Ollama가 댓글 초안 형식에 맞지 않는 응답을 반환했습니다. 다시 시도해 주세요.") from error

    drafts = response_data.get("drafts")
    if not isinstance(drafts, list) or len(drafts) < 2:
        raise RuntimeError("Ollama 응답에서 댓글 초안 두 개를 찾지 못했습니다.")

    source_text = f"{title[:300]}\n{text[:MAX_POST_CHARACTERS]}"
    cleaned_drafts = []
    for draft in drafts:
        if not isinstance(draft, dict):
            continue
        comment = str(draft.get("comment", "")).strip()
        evidence = str(draft.get("evidence", "")).strip()
        if len(evidence) >= 2 and evidence in source_text and evidence in comment:
            cleaned_drafts.append(comment)

    if len(cleaned_drafts) >= 2:
        return cleaned_drafts[:2]
    return make_evidence_based_fallback(source_text)


def make_evidence_based_fallback(source_text):
    """Return safe, readable drafts when a small local model ignores the schema."""
    facts = []
    for pattern in (r"\d{4}년", r"\d[\d,]*원", r"\d+호[가-힣]+"):
        for match in re.findall(pattern, source_text):
            if match not in facts:
                facts.append(match)

    if len(facts) < 2:
        ignored_words = {"네이버", "블로그", "입니다", "그리고", "그렇게", "정말", "소개", "내용"}
        for word in re.findall(r"[가-힣]{3,10}", source_text):
            if word not in ignored_words and word not in facts:
                facts.append(word)
            if len(facts) >= 2:
                break

    if not facts:
        raise RuntimeError("본문에서 댓글에 인용할 내용을 찾지 못했습니다.")
    if len(facts) == 1:
        facts.append(facts[0])

    first_fact, second_fact = facts[:2]
    return [
        f"“{first_fact}” 부분이 특히 인상 깊었습니다. 정성스러운 소개 잘 읽었어요.",
        f"“{second_fact}”에 담긴 이야기가 흥미로웠습니다. 공유해 주셔서 감사합니다."
    ]


class DraftHandler(BaseHTTPRequestHandler):
    def end_headers(self):
        origin = self.headers.get("Origin", "")
        if origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path != "/draft":
            self.respond(HTTPStatus.NOT_FOUND, {"error": "찾을 수 없는 경로입니다."})
            return
        if not self.headers.get("Origin", "").startswith("chrome-extension://"):
            self.respond(HTTPStatus.FORBIDDEN, {"error": "Chrome 확장 프로그램 요청만 허용됩니다."})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0 or content_length > 150000:
                raise ValueError("올바르지 않은 요청 크기입니다.")
            body = json.loads(self.rfile.read(content_length).decode("utf-8"))
            text = str(body.get("text", "")).strip()
            title = str(body.get("title", "")).strip()
            if not text:
                raise ValueError("본문을 찾지 못했습니다.")
            self.respond(HTTPStatus.OK, {"drafts": make_drafts(title, text)})
        except (ValueError, RuntimeError) as error:
            self.respond(HTTPStatus.BAD_REQUEST, {"error": str(error)})

    def respond(self, status, payload):
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format_string, *args):
        print(f"[NaverBlogAssistant] {format_string % args}")


if __name__ == "__main__":
    print(f"Naver Blog Assistant service listening at http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), DraftHandler).serve_forever()
