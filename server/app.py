"""Local-only proxy for Naver Blog Assistant's Ollama requests."""

import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HOST = "127.0.0.1"
PORT = 8765
MAX_POST_CHARACTERS = 12000
OLLAMA_API_URL = os.environ.get("OLLAMA_API_URL", "http://127.0.0.1:11434/api/generate")
MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:4b")


def make_drafts(title, text):
    prompt = f"""다음 네이버 블로그 글을 읽고, 글쓴이에게 남길 자연스러운 한국어 댓글 초안 2개를 작성하세요.

규칙:
- 각각 한두 문장으로 씁니다.
- 글의 구체적인 내용 하나를 언급합니다.
- 예의 바르고 진솔한 감상을 씁니다.
- 방문 요청, 자기 홍보, 복붙 문구, 과장된 칭찬, 해시태그, 이모지는 쓰지 않습니다.
- 두 초안을 빈 줄 하나로만 구분하고, 번호·제목·설명은 붙이지 않습니다.

글 제목: {title[:300]}
글 본문:
{text[:MAX_POST_CHARACTERS]}"""
    request_body = json.dumps({
        "model": MODEL,
        "prompt": prompt,
        "stream": False,
        "think": False,
        "options": {
            "temperature": 0.7,
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
    drafts = [line.strip() for line in output.split("\n\n") if line.strip()]
    if not drafts:
        raise RuntimeError("Ollama 응답에서 댓글 초안을 찾지 못했습니다.")
    return drafts[:2]


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
