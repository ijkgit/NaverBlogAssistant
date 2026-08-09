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

OLLAMA_API_URL = os.environ.get(
    "OLLAMA_API_URL",
    "http://127.0.0.1:11434/api/generate",
)

MODEL = os.environ.get(
    "OLLAMA_MODEL",
    "qwen3:4b",
)

# 댓글 마지막에 항상 들어가는 고정 문구
FIXED_SUFFIX = "시간 나실 때 제 블로그도 한번 방문해주세요~!"


# =========================================================
# Ollama Structured Output Schema
# =========================================================

DRAFT_RESPONSE_FORMAT = {
    "type": "object",
    "properties": {
        "comment": {
            "type": "string"
        },
        "evidence": {
            "type": "string"
        },
        "keyword": {
            "type": "string"
        },
    },
    "required": [
        "comment",
        "evidence",
        "keyword",
    ],
    "additionalProperties": False,
}


# =========================================================
# 제목 정리
# =========================================================

def clean_title(title):
    """
    HTML 태그와 네이버 에디터의 불필요한 마크업을 제거합니다.
    """

    title = str(title or "")

    # HTML 태그 제거
    title = re.sub(
        r"<[^>]+>",
        " ",
        title,
    )

    # HTML comment 제거
    title = title.replace(
        "<!-- -->",
        " ",
    )

    # HTML entity
    title = title.replace(
        "&nbsp;",
        " ",
    )

    # 연속 공백 정리
    title = re.sub(
        r"\s+",
        " ",
        title,
    )

    return title.strip()


# =========================================================
# 제목 전처리
# =========================================================

def normalize_title_for_keyword(title):
    """
    핵심 키워드를 찾기 위한 제목 전처리.
    """

    title = clean_title(title)

    # 맨 앞 [ ... ] 도입 문구 제거
    title = re.sub(
        r"^\s*\[[^\]]*\]\s*",
        "",
        title,
    )

    # 맨 앞 ( ... ) 도입 문구 제거
    title = re.sub(
        r"^\s*\([^)]{1,40}\)\s*",
        "",
        title,
    )

    # 스포일러 표시 제거
    title = re.sub(
        r"\b스포일러\s*[xX×]?\b",
        " ",
        title,
        flags=re.IGNORECASE,
    )

    title = re.sub(
        r"\b노스포일러\b",
        " ",
        title,
        flags=re.IGNORECASE,
    )

    # 네이버 블로그 suffix 제거
    title = re.sub(
        r"\s*:\s*네이버\s*블로그\s*$",
        "",
        title,
        flags=re.IGNORECASE,
    )

    # 제목 마지막의 메타 표현 제거
    title = re.sub(
        r"\s+(소식|정보|추천)\s*!*\s*$",
        "",
        title,
    )

    # 연속 특수문자 정리
    title = re.sub(
        r"!{2,}",
        "!",
        title,
    )

    title = re.sub(
        r"\?{2,}",
        "?",
        title,
    )

    title = re.sub(
        r"\s+",
        " ",
        title,
    )

    return title.strip()


# =========================================================
# 핵심 키워드 제외 단어
# =========================================================

KEYWORD_STOPWORDS = {
    # 후기 / 정보
    "후기",
    "리뷰",
    "소식",
    "정보",
    "추천",
    "소개",
    "이야기",
    "이벤트",
    "방문",
    "체험",
    "사용기",
    "사용후기",
    "구매후기",
    "한글패치",
    "패치",
    "공략",

    # 콘텐츠 종류
    "노스포일러",
    "스포일러",
    "스포",
    "영화",
    "게임",
    "맛집",
    "카페",

    # 평가 / 감탄
    "처음해보는데",
    "처음",
    "재미있고",
    "재미있게",
    "재미있는",
    "재미",
    "박력이",
    "박력",
    "긴장감",
    "기대",
    "없이",
    "시간",
    "가는",
    "줄",
    "몰랐던",
    "넘치는",
    "진짜",
    "정말",
    "너무",
    "좋은",
    "좋았던",
    "대박",
    "최고",
    "강추",
    "꼭",
    "해보세요",

    # 연결어
    "그리고",
    "그런데",
    "그래서",
    "이번",
    "오늘",
}


def is_noise_token(token):
    """
    제목에서 핵심 대상이 될 가능성이 낮은 단어인지 판단합니다.
    """

    token = token.strip()

    if not token:
        return True

    # 특수문자만 있는 경우
    if not re.search(
        r"[가-힣A-Za-z0-9]",
        token,
    ):
        return True

    # 불필요 단어
    lower_token = token.lower()

    for word in KEYWORD_STOPWORDS:
        if lower_token == word.lower():
            return True

    return False


# =========================================================
# Ollama로 핵심 키워드 추출
# =========================================================

def extract_main_keyword_with_ollama(title):
    """
    제목에서 실제 메인 대상 하나를 추출합니다.
    """

    clean = clean_title(title)

    prompt = f"""/no_think
다음 네이버 블로그 제목에서 글의 "메인 대상" 하나만 찾아라.

메인 대상이란 글쓴이가 실제로 소개하거나 후기/정보를 제공하는
작품, 상품, 게임, 영화, 음식, 장소, 제품 등의 이름이다.

반드시 제목에 실제로 존재하는 표현만 사용한다.

[중요한 예시]

제목:
[아니 이게 뭐야!?] 아이돌 슈퍼로봇대전!? PS3(플스3) 초 히로인 전기 한글패치 소식!! 처음해보는데 이거 은근 재미있고 연출이 박력이 빡!! 미소녀 슈로대 꼭 해보세요!!

정답:
초 히로인 전기

선택하면 안 되는 것:
아니 이게 뭐야
아이돌 슈퍼로봇대전
PS3
플스3
한글패치
소식
처음해보는데
재미있고
연출이 박력이 빡
미소녀 슈로대

[규칙]

1. 제목 맨 앞의 [ ] 안에 있는 문구는 메인 대상이 아니다.

2. 감탄문이나 질문문은 메인 대상이 아니다.

3. "후기", "리뷰", "소식", "추천", "정보",
   "한글패치", "공략" 등은 메인 대상이 아니다.

4. PS3, 플스3, PC, 스위치, 닌텐도 등
   플랫폼명은 다른 작품명이 있다면 선택하지 않는다.

5. 영화, 게임, 맛집, 카페 등 일반적인 종류보다
   실제 고유명사를 우선한다.

6. 여러 단어로 이루어진 고유명사는 전체를 유지한다.

7. 제목에 "OO 후기"가 있으면 OO를 우선적으로 본다.
   단, "후기" 자체는 메인 대상이 아니다.

8. 제목에서 실제 작품명, 상품명, 제품명, 장소명처럼
   보이는 고유한 표현을 최우선으로 선택한다.

9. 메인 대상은 하나만 선택한다.

10. 가능한 한 2~5단어 정도의 짧은 표현을 선택한다.

11. 반드시 제목에 실제로 존재하는 문자열을 그대로 반환한다.

[출력]

반드시 JSON만 출력한다.

{{"keyword":"메인 대상"}}

설명하지 마라.

제목:
{clean}
"""

    request_body = json.dumps(
        {
            "model": MODEL,
            "prompt": prompt,
            "stream": False,
            "think": False,
            "format": {
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string"
                    }
                },
                "required": [
                    "keyword"
                ],
                "additionalProperties": False,
            },
            "options": {
                "temperature": 0.1,
                "num_predict": 80,
            },
        }
    ).encode("utf-8")

    request = Request(
        OLLAMA_API_URL,
        data=request_body,
        method="POST",
        headers={
            "Content-Type": "application/json",
        },
    )

    try:
        with urlopen(
            request,
            timeout=45,
        ) as response:

            payload = json.loads(
                response.read().decode(
                    "utf-8"
                )
            )

    except (
        HTTPError,
        URLError,
    ):
        return ""

    output = str(
        payload.get(
            "response",
            "",
        )
    ).strip()

    try:
        data = json.loads(
            output
        )

    except json.JSONDecodeError:
        return ""

    keyword = str(
        data.get(
            "keyword",
            "",
        )
    ).strip()

    if not keyword:
        return ""

    # 반드시 제목에 존재해야 함
    if keyword not in clean:
        return ""

    return keyword


# =========================================================
# 후보에서 불필요 단어 제거
# =========================================================

def remove_noise_from_candidate(candidate):

    words = candidate.split()

    filtered = []

    for word in words:

        clean_word = re.sub(
            r"[!?]+$",
            "",
            word,
        )

        if not is_noise_token(
            clean_word
        ):
            filtered.append(
                clean_word
            )

    return " ".join(
        filtered
    ).strip()


# =========================================================
# 후보 추출
# =========================================================

def find_best_candidate(text):

    text = re.sub(
        r"\[[^\]]*\]",
        " ",
        text,
    )

    text = re.sub(
        r"\([^)]*\)",
        " ",
        text,
    )

    text = re.sub(
        r"[!?]+",
        " ",
        text,
    )

    text = re.sub(
        r"\s+",
        " ",
        text,
    ).strip()

    words = text.split()

    filtered = []

    for word in words:

        clean_word = word.strip(
            ".,!?~:;|"
        )

        if is_noise_token(
            clean_word
        ):
            continue

        filtered.append(
            clean_word
        )

    if not filtered:
        return ""

    # 너무 긴 문장 전체가 후보가 되는 것을 방지
    if len(filtered) >= 4:
        filtered = filtered[-3:]

    return " ".join(
        filtered
    ).strip()


# =========================================================
# 규칙 기반 핵심 키워드 fallback
# =========================================================

def extract_main_keyword_fallback(title):

    original = clean_title(
        title
    )

    title = normalize_title_for_keyword(
        original
    )

    # -----------------------------------------------------
    # 1. "OO 후기"
    # -----------------------------------------------------

    match = re.search(
        r"([가-힣A-Za-z0-9·]+(?:\s+[가-힣A-Za-z0-9·]+){0,3})\s+후기\b",
        title,
    )

    if match:

        candidate = match.group(
            1
        ).strip()

        candidate = remove_noise_from_candidate(
            candidate
        )

        if candidate:
            return candidate + " 후기"

    # -----------------------------------------------------
    # 2. "OO 리뷰"
    # -----------------------------------------------------

    match = re.search(
        r"([가-힣A-Za-z0-9·]+(?:\s+[가-힣A-Za-z0-9·]+){0,3})\s+리뷰\b",
        title,
    )

    if match:

        candidate = match.group(
            1
        ).strip()

        candidate = remove_noise_from_candidate(
            candidate
        )

        if candidate:
            return candidate + " 리뷰"

    # -----------------------------------------------------
    # 3. 한글패치 / 소식 / 추천 / 공략 앞쪽
    # -----------------------------------------------------

    for marker in [
        "한글패치",
        "소식",
        "추천",
        "공략",
        "정보",
    ]:

        if marker in title:

            before = title.split(
                marker,
                1,
            )[0].strip()

            candidate = find_best_candidate(
                before
            )

            if candidate:
                return candidate

    # -----------------------------------------------------
    # 4. 하이픈 앞쪽
    # -----------------------------------------------------

    before_dash = re.split(
        r"\s*[-–—]\s*",
        title,
        maxsplit=1,
    )[0].strip()

    candidate = find_best_candidate(
        before_dash
    )

    if candidate:
        return candidate

    # -----------------------------------------------------
    # 5. 전체 제목
    # -----------------------------------------------------

    candidate = find_best_candidate(
        title
    )

    if candidate:
        return candidate

    # -----------------------------------------------------
    # 6. 최후 fallback
    # -----------------------------------------------------

    words = [
        word
        for word in re.findall(
            r"[가-힣A-Za-z0-9]+",
            title,
        )
        if not is_noise_token(word)
    ]

    if words:
        return " ".join(
            words[:3]
        )

    return title[:20]


# =========================================================
# 핵심 키워드 검증
# =========================================================

def validate_keyword(
    keyword,
    title,
):

    keyword = clean_title(
        keyword
    )

    title = clean_title(
        title
    )

    if not keyword:
        return False

    if len(keyword) < 2:
        return False

    # 반드시 제목에 실제 존재
    if keyword not in title:
        return False

    bad_patterns = [
        r"^스포일러",
        r"^노스포일러",
        r"^아니\s*이게",
        r"네이버\s*블로그",
        r"한글패치$",
        r"소식$",
        r"추천$",
        r"정보$",
        r"공략$",
    ]

    for pattern in bad_patterns:

        if re.search(
            pattern,
            keyword,
            flags=re.IGNORECASE,
        ):
            return False

    return True


# =========================================================
# 최종 핵심 키워드
# =========================================================

def extract_main_keyword(title):

    title = clean_title(
        title
    )

    # 1차: Ollama
    keyword = extract_main_keyword_with_ollama(
        title
    )

    if validate_keyword(
        keyword,
        title,
    ):
        return keyword

    # 2차: 규칙 기반
    keyword = extract_main_keyword_fallback(
        title
    )

    if validate_keyword(
        keyword,
        title,
    ):
        return keyword

    # 3차
    return keyword or title[:20]


# =========================================================
# 댓글 앞 리스트 번호 제거
# =========================================================

def clean_comment_prefix(comment):
    """
    모델이 댓글 앞에 붙이는 리스트 번호나
    마크다운 리스트 기호를 제거합니다.

    예:

    1. 은은한 살냄새 향수 궁금했는데...
    ->
    은은한 살냄새 향수 궁금했는데...

    2) 은은한 살냄새 향수 궁금했는데...
    ->
    은은한 살냄새 향수 궁금했는데...

    - 은은한 살냄새 향수 궁금했는데...
    ->
    은은한 살냄새 향수 궁금했는데...
    """

    comment = str(
        comment or ""
    ).strip()

    # 숫자 리스트
    comment = re.sub(
        r"^\s*\d+\s*[.)]\s*",
        "",
        comment,
    )

    # 원문자 숫자
    comment = re.sub(
        r"^\s*[①②③④⑤⑥⑦⑧⑨⑩]\s*",
        "",
        comment,
    )

    # 마크다운 리스트
    comment = re.sub(
        r"^\s*[-*]\s+",
        "",
        comment,
    )

    return comment.strip()


# =========================================================
# 댓글 fallback
# =========================================================

def make_comment_fallback(keyword):

    keyword = clean_comment_prefix(
        keyword.strip()
    )

    comment = (
        f"{keyword} 궁금했는데, "
        f"너무 친절하게 알려주셔서 "
        f"잘 읽어봤어요~! 감사합니다.\n\n"
        f"{FIXED_SUFFIX}"
    )

    return clean_comment_prefix(
        comment
    )


# =========================================================
# 댓글 생성
# =========================================================

def make_drafts(title, text):

    clean = clean_title(
        title[:300]
    )

    # 먼저 핵심 키워드를 별도로 추출
    keyword = extract_main_keyword(
        clean
    )

    prompt = f"""/no_think
네이버 블로그 글에 남길 자연스러운 댓글을 딱 1개 작성하세요.

[핵심 대상]
{keyword}

[원하는 스타일]

"{keyword} 궁금했는데, 너무 친절하게 알려주셔서 잘 읽어봤어요~! 감사합니다."

[반드시 지킬 규칙]

1. 댓글은 딱 1개만 작성합니다.

2. 댓글 앞에 숫자를 절대 붙이지 마세요.
   "1.", "2.", "3)" 등의 번호를 사용하지 마세요.

3. 댓글 앞에 "-", "*", "①" 등의 목록 기호도 사용하지 마세요.

4. 댓글 내용만 출력하세요.

5. 첫 문장에는 반드시 핵심 대상 "{keyword}"를 그대로 포함하세요.

6. 첫 문장은 다음과 같은 자연스러운 느낌으로 작성하세요.

   "{keyword} 궁금했는데, 너무 친절하게 알려주셔서 잘 읽어봤어요~! 감사합니다."

7. 첫 문장은 한 문장으로 작성합니다.

8. 두 번째 줄에는 반드시 다음 문장을 그대로 사용합니다.

시간 나실 때 제 블로그도 한번 방문해주세요~!

9. 제목 전체를 댓글에 복사하지 마세요.

10. 제목 맨 앞의 [ ] 안 감탄문을 사용하지 마세요.

11. "스포일러X", "노스포일러", "한글패치",
    "소식", "추천", "정보" 등의 메타 표현을
    핵심 대상으로 사용하지 마세요.

12. 실제로 방문했거나 직접 경험했다고 말하지 마세요.

13. 제목에 없는 사실이나 경험을 추가하지 마세요.

14. 해시태그를 사용하지 마세요.

15. 이모지를 사용하지 마세요.

16. 과장된 칭찬을 하지 마세요.

17. 설명이나 분석을 출력하지 마세요.

[출력 형식]

반드시 JSON 하나만 출력하세요.

{{"comment":"댓글","evidence":"제목에서 그대로 가져온 핵심 표현","keyword":"{keyword}"}}

[제목]
{clean}

[본문]
{text[:MAX_POST_CHARACTERS]}
"""

    request_body = json.dumps(
        {
            "model": MODEL,
            "prompt": prompt,
            "stream": False,
            "think": False,
            "format": DRAFT_RESPONSE_FORMAT,
            "options": {
                "temperature": 0.35,
                "num_predict": 180,
            },
        }
    ).encode("utf-8")

    request = Request(
        OLLAMA_API_URL,
        data=request_body,
        method="POST",
        headers={
            "Content-Type": "application/json",
        },
    )

    try:

        with urlopen(
            request,
            timeout=45,
        ) as response:

            payload = json.loads(
                response.read().decode(
                    "utf-8"
                )
            )

    except HTTPError as error:

        details = error.read().decode(
            "utf-8",
            errors="replace",
        )

        raise RuntimeError(
            f"Ollama 요청이 실패했습니다 "
            f"({error.code}): {details}"
        ) from error

    except URLError as error:

        raise RuntimeError(
            "Ollama 서버에 연결하지 못했습니다. "
            "Ollama가 실행 중이고 모델이 설치되어 있는지 확인하세요."
        ) from error

    output = str(
        payload.get(
            "response",
            "",
        )
    ).strip()

    try:

        response_data = json.loads(
            output
        )

    except json.JSONDecodeError:

        return [
            make_comment_fallback(
                keyword
            )
        ]

    comment = str(
        response_data.get(
            "comment",
            "",
        )
    ).strip()

    evidence = str(
        response_data.get(
            "evidence",
            "",
        )
    ).strip()

    returned_keyword = str(
        response_data.get(
            "keyword",
            "",
        )
    ).strip()

    # -----------------------------------------------------
    # 응답 검증
    # -----------------------------------------------------

    if not comment:

        return [
            make_comment_fallback(
                keyword
            )
        ]

    # 핵심 키워드가 댓글에 반드시 존재
    if keyword not in comment:

        return [
            make_comment_fallback(
                keyword
            )
        ]

    # evidence 검증
    if evidence:

        if evidence not in clean:

            return [
                make_comment_fallback(
                    keyword
                )
            ]

        if evidence not in comment:

            return [
                make_comment_fallback(
                    keyword
                )
            ]

    # keyword 일치 여부
    if returned_keyword:

        if returned_keyword != keyword:

            return [
                make_comment_fallback(
                    keyword
                )
            ]

    # 고정 문구 반드시 존재
    if FIXED_SUFFIX not in comment:

        return [
            make_comment_fallback(
                keyword
            )
        ]

    # 고정 문구가 두 번 이상 나오면 잘못된 응답
    if comment.count(
        FIXED_SUFFIX
    ) != 1:

        return [
            make_comment_fallback(
                keyword
            )
        ]

    # 지나치게 긴 댓글 방지
    if len(comment) > 300:

        return [
            make_comment_fallback(
                keyword
            )
        ]

    # -----------------------------------------------------
    # 최종적으로 리스트 번호 제거
    # -----------------------------------------------------

    # 최종 방어: 모델/UI가 어떤 경우에도 리스트 번호를 반환하지 않도록 합니다.
    comment = clean_comment_prefix(
        comment
    )

    return [
        comment
    ]


# =========================================================
# HTTP Handler
# =========================================================

class DraftHandler(
    BaseHTTPRequestHandler
):

    def end_headers(self):

        origin = self.headers.get(
            "Origin",
            "",
        )

        if origin.startswith(
            "chrome-extension://"
        ):

            self.send_header(
                "Access-Control-Allow-Origin",
                origin,
            )

            self.send_header(
                "Vary",
                "Origin",
            )

        super().end_headers()

    def do_OPTIONS(self):

        self.send_response(
            HTTPStatus.NO_CONTENT
        )

        self.send_header(
            "Access-Control-Allow-Methods",
            "POST, OPTIONS",
        )

        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type",
        )

        self.end_headers()

    def do_POST(self):

        if self.path != "/draft":

            self.respond(
                HTTPStatus.NOT_FOUND,
                {
                    "error": "찾을 수 없는 경로입니다."
                },
            )

            return

        origin = self.headers.get(
            "Origin",
            "",
        )

        if not origin.startswith(
            "chrome-extension://"
        ):

            self.respond(
                HTTPStatus.FORBIDDEN,
                {
                    "error": (
                        "Chrome 확장 프로그램 요청만 허용됩니다."
                    )
                },
            )

            return

        try:

            content_length = int(
                self.headers.get(
                    "Content-Length",
                    "0",
                )
            )

            if (
                content_length <= 0
                or content_length > 150000
            ):

                raise ValueError(
                    "올바르지 않은 요청 크기입니다."
                )

            raw_body = self.rfile.read(
                content_length
            )

            body = json.loads(
                raw_body.decode(
                    "utf-8"
                )
            )

            title = str(
                body.get(
                    "title",
                    "",
                )
            ).strip()

            text = str(
                body.get(
                    "text",
                    "",
                )
            ).strip()

            if not title:

                raise ValueError(
                    "블로그 제목을 찾지 못했습니다."
                )

            if not text:

                raise ValueError(
                    "본문을 찾지 못했습니다."
                )

            drafts = make_drafts(
                title,
                text,
            )

            self.respond(
                HTTPStatus.OK,
                {
                    "drafts": drafts
                },
            )

        except json.JSONDecodeError:

            self.respond(
                HTTPStatus.BAD_REQUEST,
                {
                    "error": (
                        "올바른 JSON 요청이 아닙니다."
                    )
                },
            )

        except (
            ValueError,
            RuntimeError,
        ) as error:

            self.respond(
                HTTPStatus.BAD_REQUEST,
                {
                    "error": str(error)
                },
            )

        except Exception as error:

            self.respond(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "error": (
                        f"처리 중 오류가 발생했습니다: {error}"
                    )
                },
            )

    def respond(
        self,
        status,
        payload,
    ):

        encoded = json.dumps(
            payload,
            ensure_ascii=False,
        ).encode("utf-8")

        self.send_response(
            status
        )

        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8",
        )

        self.send_header(
            "Content-Length",
            str(len(encoded)),
        )

        self.end_headers()

        self.wfile.write(
            encoded
        )

    def log_message(
        self,
        format_string,
        *args,
    ):

        print(
            f"[NaverBlogAssistant] "
            f"{format_string % args}"
        )


# =========================================================
# Server Start
# =========================================================

if __name__ == "__main__":

    print(
        f"Naver Blog Assistant service "
        f"listening at "
        f"http://{HOST}:{PORT}"
    )

    server = ThreadingHTTPServer(
        (
            HOST,
            PORT,
        ),
        DraftHandler,
    )

    try:

        server.serve_forever()

    except KeyboardInterrupt:

        print(
            "\nNaver Blog Assistant service stopped."
        )

    finally:

        server.server_close()