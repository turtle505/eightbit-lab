# 🧬 8-bit Lab

`eightbit-lab` — 연구와 일상 업무를 맡기는 도트 AI 에이전트 사무실.

단백질 구조 딥러닝 연구용 **AI 에이전트 사무실**. Claude Code 에이전트(직원) 여러 명을 병렬로 돌리고,
도트 게임 사무실에서 상태를 보며 업무 지시 · 승인 · 원격 GPU job 관리를 한다.

## 실행

```bash
npm install
npm run dev          # 백엔드(8787) + 프론트(5173) 동시 실행 → http://localhost:5173
# 또는 배포 모드
npm run build && npm start   # → http://127.0.0.1:8787
```

인증은 이 Mac의 `claude` CLI 로그인(Pro/Max 구독)을 그대로 사용한다. 데이터는 `data/office.db`(SQLite)에 저장된다.

## 사용법

| 하고 싶은 것 | 방법 |
|---|---|
| 업무 지시 | 직원 클릭(또는 숫자키 1–5) → 하단 입력창에 지시 |
| 작업 배정 | 작업 보드에 카드 추가 → 카드를 사무실의 직원에게 드래그 (또는 카드의 드롭다운) |
| 승인 | 직원이 손을 들고 `!` 표시 → 노란 승인 패널에서 승인/거부 |
| 결과 확인 | 작업이 끝나면 카드가 "검토"로 이동, `보고`를 펼쳐 확인 후 "완료" |
| 오늘 할 일 | `✅ 오늘 할 일` 패널: Obsidian 데일리 노트의 체크박스를 체크·수정(더블클릭)·추가(＋, ↳)·삭제. 노트 파일에 바로 반영되고 Obsidian에서 고친 것도 몇 초 안에 보임 (`office.local.yaml` 의 `obsidian` 설정 필요) |
| 보고 피드 | `📨 보고` 박스: 보고서 파일이 저장·수정되거나 실행이 끝나면 채팅처럼 아래로 쌓임 (마크다운) |
| 보고서 다시 보기 | 상단 `보고서` 탭: `workspaces/<직원>/reports/` 의 .md 파일을 폴더 트리로 열람, 안 읽은 개수 표시. `?view=reports` 로 별도 창 |
| 중지 / 새 세션 | 직원 패널의 `중지`, `새 세션` (세션은 기본적으로 이어짐) |
| 예약 업무 | 루틴 패널: `+ 새 루틴` 등록·수정·삭제(확인 후), 켜기/끄기, `지금 실행` — 비서에게 말로 맡겨도 됨 |
| 화면 전환 | 상단 우측 `게임 / 콘솔 / 보고서` 버튼 또는 <kbd>`</kbd> (마지막 화면 기억, `?view=console` 로 바로 열기) |

**구독 사용량**: 상단바에 Claude 구독의 **세션(5시간)·주간 사용량 %**와 초기화 시각을 표시 (모델별 주간 한도가 있으면 함께). 3분마다, 직원 작업이 끝날 때, 클릭할 때 갱신. 토큰을 쓰지 않는 빈 세션으로 조회하며, SDK의 실험적 API라 바뀌면 "사용량 —"으로 표시될 수 있음. 직원별 값은 한도 %가 아니라 **사무실 전체 사용 중 비중**.

**콘솔 화면**: 게임 화면과 같은 데이터를 표로 보여주는 업무용 화면. 직원 표(상태·현재 활동·작업·세션·누적 사용량), 작업 표(상태/담당 바로 변경, 행 펼쳐서 지시·보고 확인), 전 직원 활동 피드(직원별 필터), 승인 요청(항상 표시).
단축키: <kbd>1</kbd>–<kbd>5</kbd> 직원 선택 · <kbd>j</kbd>/<kbd>k</kbd> 이동 · <kbd>/</kbd> 지시 입력 · <kbd>a</kbd>/<kbd>d</kbd> 첫 승인 요청 승인/거부 · <kbd>Esc</kbd> 해제.

캐릭터 상태: ☕ 라운지 = 대기 · 책상에서 타이핑 = 작업 중 (모니터 색: 파랑 편집 / 초록 명령 실행 / 하늘색 웹 조사) ·
`...` = 생각 중 · 손들고 `!` = 승인 대기 · 서버실로 이동 = 원격 GPU 작업 · 반짝임 = 완료.

## 설정

**개인 설정은 `config/<이름>.local.yaml`에** 두세요 (git에 올라가지 않음). 기본 파일 위에 덮어씌워집니다.
`office.local.yaml`은 항목별로 덮어쓰고, 직원·루틴·서버 목록은 같은 `id`(서버는 `name`)면 덮어쓰고 새로운 건 추가됩니다.
연구 repo 경로, 서버, 개인 루틴처럼 공개하면 안 되는 내용은 전부 `.local.yaml`로.

```yaml
# config/office.local.yaml 예시
researchRepo: ~/research/my-protein-model
maxConcurrent: 4
```

- `config/office.yaml` — 동시 근무 인원(`maxConcurrent`, 구독 rate limit 보호), 모델, 연구 repo 경로
  - `researchRepo`를 지정하면 모델/데이터 엔지니어는 그 repo의 **git worktree**(브랜치 `office/<id>`)를 각자 받아 충돌 없이 작업
  - 비워두면 모두 `workspaces/shared`에서 작업
- `config/roles.yaml` — 직원 정의: 역할 프롬프트, 승인 없이 허용할 도구(`autoAllow`), 캐릭터 색
- `config/routines.yaml` — 예약 루틴 초기값 (cron 5필드, 이 Mac 현지 시간, 백엔드가 켜져 있을 때만 실행). 처음 실행할 때 DB로 가져오고, 이후 변경은 UI/비서로 함
  - 기본: 평일 09:00 아침 브리핑, 평일 18:00 저녁 일일 리포트 (켜짐) · 금 17:00 주간 회고, 평일 08:30 Obsidian 데일리 노트 (꺼짐)
- `config/servers.local.yaml` — GPU 서버 (`servers.example.yaml` 복사, git 제외). 서버마다 `type: ssh | slurm`
  - `ssh_host`는 `~/.ssh/config` alias, **비밀번호 없이(키 인증) 접속돼야 함**
  - 직원은 `mcp__lab__*` 도구(list_servers, gpu_status, submit_job, job_status, tail_log, cancel_job, fetch_results)로 서버를 사용
  - job이 끝나면 제출한 직원에게 자동으로 알려 결과를 보고하게 함

## 직원 세션

직원마다 Claude Code 세션을 **하나 열어 두고** 지시를 그 세션에 밀어 넣는다. 지시마다 프로세스를 새로 띄우지 않는다.

- 첫 지시만 느리다(프로세스 시작·세션 로드·MCP 연결). 그다음부터는 바로 시작한다 — 비서2 실측 **49.6초 → 1.0초**.
- 일하는 중에 보낸 지시는 **현재 턴이 끝나는 즉시** 처리된다(턴을 중간에 끊지는 않는다).
- `sessionIdleMinutes`(기본 30) 동안 일이 없으면 세션을 닫고, 다음 지시 때 **대화를 이어서(resume)** 다시 연다.
- **중지**는 현재 턴만 끊고 세션은 살려 둔다. 맥락까지 비우려면 **새 세션** 버튼.
- 열려만 있고 쉬는 세션은 `maxConcurrent`(동시 근무 인원)에 포함되지 않는다. 지금 턴을 돌고 있는 직원만 센다.
- 직원 패널과 콘솔 표에 `🟢 세션 열림` / `⚪ 세션 대기`로 표시된다.

## 프로젝트 세션

**프로젝트** 탭에서 호스트와 폴더를 고르면, 그 폴더에서 Claude Code 세션이 열린다. 한 프로젝트에 세션을 여러 개 띄울 수 있고 서로 독립이다
(`ssh <host>` 하고 `cd ~/project/<이름>` 해서 `claude` 를 여러 개 띄운 것과 같다).

- 폴더는 **이미 있어야** 한다. 사무실이 만들지 않는다. 입력칸에서 그 호스트의 `projectRoot` 하위 폴더를 고를 수 있다.
- 세션마다 **이름**을 줄 수 있다 (비우면 "세션 N"). 나중에 바꾸는 건 직원과 같은 ✏️ 버튼.
- 세션마다 로그와 입력칸이 따로 있다. 직원들과 마찬가지로 세션이 유지되고, 승인 카드와 랩 서버 가드도 똑같이 적용된다.
- 세션은 기본적으로 **탭에만** 있다. **“사무실에 들이기”** 를 누르면 빈 책상을 하나 받아 게임 화면에 캐릭터로 나타나고, 빼면 그 책상을 반납한다.
  올리고 싶은 것만 올리면 되니, 띄운 세션이 많아도 사무실은 고른 것만 보여준다.
  `roles.yaml` 에 `host` + `cwd` 를 적어 직원으로 선언하는 방법도 그대로 쓸 수 있다.
- 작업 보드와 담당 드롭다운에는 나오지 않는다. 끝난 일은 보고 피드(📨)에 뜬다.
- 같은 프로젝트의 세션들은 셔츠 색 계열이 같아서 한눈에 묶인다.
- 세션을 닫으면 그 대화는 사라진다 (폴더의 파일은 그대로). 프로젝트를 보관하면 세션이 모두 닫힌다.
- 구독을 쓰므로 `maxConcurrent` 에 함께 포함된다.

## 다른 머신에서 세션 돌리기 / 백엔드 옮기기

`config/office.local.yaml` 의 `hosts` 에 머신을 적고, 직원이나 프로젝트에 `host: <id>` 를 주면 그 머신에서 Claude Code 세션이 돈다.

```yaml
hosts:
  - { id: desktop, name: "🖥 desktop", ssh: local, projectRoot: "~/project" }
  - { id: gpu1, name: "🧮 gpu1", ssh: gpu1, projectRoot: "~/project", claudePath: "/home/me/.local/bin/claude" }
```

- `ssh: local` = 백엔드가 도는 그 머신. 그 밖에는 `~/.ssh/config` 의 alias (키 인증 필수).
- **분당 접속 한도**: `sshPerMinute`(기본 5). 서버마다 다르게 하려면 `hosts` 항목에 `sshPerMinute` 를 적는다 (`0` 이면 그 서버는 제한 없음).
  **직원이 Bash 로 쓰는 `ssh`·`scp`·`rsync` 도 같은 한도를 쓴다** — 넘으면 승인 카드도 뜨지 않고 바로 거부되고, 몇 초 뒤에 다시 하라고 알려준다.
  호스트 배지에 `분당 ssh 3/5` 가 툴팁으로 뜨고, 한도의 80% 를 넘으면 `⏳ 4/5` 가 눈에 보이게 표시된다.
- (아래는 그 한도를 실제로 지키게 만드는 장치들)
- **분당 접속 한도 세부**: `sshPerMinute`(기본 5). 사무실이 호스트 한 대에 여는 ssh/scp 를 1분에 그만큼으로 묶는다.
  상태 확인·GPU 폴링은 넘으면 그 회차를 건너뛰고(한 번 걸렀다고 서버가 죽은 것으로 보지 않는다), 세션 열기는 자리가 날 때까지 기다린다.
  직원이 Bash 로 직접 쓰는 `ssh`·`scp` 는 어차피 매번 매니저 승인 카드를 거친다.
- **접속 횟수 주의**: 공유 서버는 ssh/scp 를 자주 열면 차단되는 경우가 있다. 그래서 상태 확인·폴더 조회·GPU 폴링 같은 **짧고 잦은 명령은
  호스트마다 ssh 연결 하나를 공유**한다 (`ControlMaster`, 소켓은 `data/ssh/`). 세션은 일부러 각자 연결을 쓴다 — 하나가 끊겨도 나머지가 같이 죽지 않게.
  **호스트 상태 확인은 시작할 때 한 번뿐이다.** 연결되는 동안에는 주기적으로 두드리지 않는다 — 쉬고 있는 서버에 가는 접속은 0회다.
  (연결에 실패했을 때만 간격을 늘려가며 재시도하고, 세션을 열 때와 직원 패널의 ↻ 버튼으로 다시 확인한다.
  대신 배지가 낡을 수 있다: 서버가 내려가도 쓸 때까지는 모른다.)
- **`claudePath` 는 절대 경로로**: 비대화형 ssh 는 보통 `~/.local/bin` 을 PATH 에 넣지 않는다.
- 머신마다 claude CLI 설치 + 구독 로그인이 따로 필요하다. 30초마다 `claude --version` 으로 확인하고, 죽은 머신에서는 세션이 시작되지 않는다.
- 세션 ID 는 그 기록을 가진 머신에서만 의미가 있다. 직원을 다른 머신으로 옮기거나 **백엔드 자체를 옮기면** 자동으로 새 세션에서 시작한다.
- 원격 세션은 첨부 파일을 읽을 수 없다 (파일이 백엔드 디스크에 있음). `mcp__lab__fetch_results` 도 백엔드 디스크로 내려받는다.

**백엔드를 서버로 옮기려면**: `git clone` → `npm ci` → `npm run build` → `deploy/eightbit-lab.service` 참고.
`data/office.db` 와 `workspaces/` 를 rsync 하면 작업·루틴·첨부가 이어진다 (첨부 경로는 `workspaceRoot` 기준 상대 경로로 저장된다).
그 서버의 `servers.local.yaml` 에서 자기 자신은 `ssh_host: local` 로 두면 ssh 를 거치지 않는다.
Obsidian 할 일 패널을 계속 쓰려면 vault 를 그 서버에 동기화하고 (Syncthing 등) `obsidian.vault` 를 그 사본에 맞춘다.
**맥과 서버에서 동시에 띄우지 말 것** — 루틴이 두 번 실행된다.

## 접속 잠금 (`authToken`)

`config/office.local.yaml` 에 토큰을 두면 사무실이 잠긴다. 비워 두면 잠기지 않는다 (시작할 때 경고와 함께 쓸 토큰을 하나 출력해 준다).

```yaml
authToken: "여기에-긴-무작위-문자열"
```

- **브라우저**: 첫 접속에 한 번 입력하면 쿠키(HttpOnly, SameSite=Strict)로 기억한다.
- **스크립트·curl**: `X-Office-Token: <토큰>` 헤더.
- WebSocket 과 `/api` 양쪽에서 검사하고, 비교는 양쪽을 해시한 뒤 하므로 길이나 타이밍이 새지 않는다.

**왜 필요한가**: 백엔드는 루프백에만 열리지만, 그 머신에 SSH 로 들어올 수 있는 사람은 누구나 포트에 닿는다.
`authorized_keys` 에 키가 여러 개 있다면 "서버에 로그인할 수 있는 사람"과 "직원을 조종할 수 있는 사람"이 같아진다. 토큰이 그 둘을 분리한다.

## 접속 범위

백엔드는 `127.0.0.1`에만 바인딩되고, 브라우저에서 오는 요청은 **Origin이 사무실 자신이나 vite 개발 서버(5173)일 때만** 받는다 (WebSocket과 `/api` 모두).
WebSocket은 CORS가 적용되지 않아서, 이 검사가 없으면 매니저가 열어 둔 아무 웹페이지나 `ws://127.0.0.1:8787/ws`에 붙어 직원에게 지시하거나 승인을 대신 누를 수 있다.

## 첨부 파일

작업 폼의 📎(콘솔은 `첨부`)이나 직원 지시창에 파일을 고르거나 끌어다 놓으면 첨부된다 (파일당 50 MB).
파일은 `workspaces/attachments/<날짜>/`에 저장되고, 담당 직원의 지시문 끝에 `#id 이름 (크기, 형식): 절대경로` 목록이 붙는다. 모든 직원 세션이 이 폴더를 읽을 수 있다.

- csv·txt·json, 이미지(png/jpg/gif/webp), pdf는 그대로 읽는다. 로컬 모델(비서2)도 이미지를 읽는다.
- docx·doc·rtf·odt·html은 올릴 때 macOS `textutil`로 `.txt` 변환본을 옆에 만들어 경로를 같이 준다. xlsx는 직원이 pandas/openpyxl로 읽는다.
- 팀장은 받은 첨부를 `create_task`의 `attachments: [id]`로 담당자에게 넘긴다. 작업 카드의 📎 링크로 원본을 열 수 있다.
- 작업이나 지시에 붙지 않은 업로드는 24시간 뒤 지워진다.

## 권한: 자동 모드 / 승인 받기

- 직원은 기본으로 **🤖 자동 모드**로 일한다. 모델 분류기가 안전하다고 본 도구는 바로 실행하고, 애매한 것만 승인 카드로 올라온다.
  직원 패널 제목줄의 `🤖 자동` / `✋ 승인` 버튼으로 직원마다 바꿀 수 있다 (다음 지시부터 적용). 기본값은 `office.yaml`의 `permissionMode`.
- **랩 서버에 닿는 호출은 자동 모드에서도 항상 승인 카드가 뜬다** (`submit_job`/`cancel_job`/`fetch_results`, 그리고 `ssh`·`scp`·`rsync`·`sftp`가 든 Bash 명령).
  직원이 웹·논문을 읽다가 숨은 지시에 넘어가더라도, 분류기 한 번으로 GPU 서버에서 명령이 실행되지는 않게 하기 위함이다.
  읽기 전용(`gpu_status`, `job_status`, `tail_log`)은 그대로 자동이고, `autoAllow`나 승인된 스킬의 `office-allow`에 정확히 적어 두면 예외가 된다.
- 작업 카드에 **🔒 승인 받기**를 체크하면, 담당자가 자동 모드여도 그 작업은 `autoAllow` 밖 도구마다 승인을 받는다.
  팀장은 삭제·덮어쓰기, git push, GPU job 취소·대량 제출, 외부 전송이 들어간 작업을 위임할 때 `requireApproval: true`로 넘긴다.

## 직원

| id | 자리 | 하는 일 |
|---|---|---|
| `exec` | 팀장 책상 (👑) | 실행 팀장 — 모델 구현·데이터 처리·분석을 직접 하고, GPU job 을 제출하고, 일을 나눠 맡긴다 |
| `lit` | 격자 | 논문·웹 조사 |
| `eval` | 격자 | 지표 계산·해석, 그림·리포트 |
| `aide1`, `aide2` | 격자 | 연구 보조 — 전문 분야 없이 그때그때 맡기는 일 (정리·스크립트·간단한 조사) |
| `sec` | 리셉션 | 루틴, 사무실 도구, 보고서 정리 |

`roles.yaml` 맨 위의 **`common:`** 블록은 모든 직원(프로젝트 세션 포함)의 프롬프트 앞에 붙는다 —
정직하게 보고하기, 고치기 전에 읽기, 랩 서버 예절, 보고 형식 같은 공통 규칙을 한 곳에서 관리한다.

`roles.yaml` 에서 역할을 빼면, 그 사람에게 배정돼 있던 작업 카드는 사라지지 않고 **미배정으로 돌아온다** (진행 중이던 것은 할 일로).

## 비서 직원 (Hana)

매니저 책상 옆 리셉션 자리. `mcp__office__*` 도구로 사무실 전체를 본다:
`office_status`(직원·job·서버 현황), `list_tasks`, `office_activity`(최근 N시간 직원별 활동), `list_routines`, `create_routine`/`update_routine`/`delete_routine`(루틴 관리), `create_task`(다른 직원에게 위임).
위임과 루틴 변경은 기본적으로 **매니저 승인 필요**이고, 루틴 삭제는 승인할 때 확인 창이 한 번 더 뜬다.

### 루틴 = 스킬 한 번 실행
비서에게 "매주 금요일 5시에 ○○ 하는 루틴 만들고 싶어"라고 말하면, 비서가 몇 가지를 물어 정리한 뒤
`list_skills` / `save_skill`로 **사무실 스킬**(`workspaces/office-skills/skills/<이름>/SKILL.md`, git 미포함)을 만들고 그 스킬을 실행하는 루틴을 등록한다.
스킬은 모든 직원 세션에 `office:<이름>`으로 로드된다.
스킬 프런트매터의 `office-allow`(예: `Bash(python3 "/경로/script.py"*)`)에 적힌 도구는 **그 스킬을 실행하는 루틴에서만** 승인 없이 실행된다.
매니저가 승인한 파일 내용 그대로일 때만 적용되고, 파일이 바뀌면 루틴 패널에 `⚠️ 재승인 필요`가 뜬다. 리포트는 `workspaces/secretary/reports/` 에 저장된다.

직원 세션에서는 claude.ai 연동(Gmail, Google Calendar 등)이 보이지 않는다. 쓸 수 있는 것은 로컬 플러그인 MCP(PubMed, bioRxiv 등)와 skill(daily-note 등)이다.

## 비서2 (Mini) — 로컬 모델

Hana가 Claude 구독으로 일한다면, 비서2는 **desktop GPU의 Ollama 모델**로 일한다 (구독 사용량을 쓰지 않음, 서버실 유리벽 옆 자리).
현황 확인·요약·메모 같은 가벼운 일용이고, 웹 검색(WebSearch)은 없다.

- `config/office.local.yaml`의 `providers`에 Ollama 서버를 적고, 직원 정의에 `provider: <id>`를 붙이면 그 직원은 로컬 모델로 실행된다.
  ```yaml
  providers:
    - { id: desktop, name: "🖥 desktop", kind: ollama, ssh_host: desktop, remotePort: 11434, localPort: 11435, model: "qwen3.5:9b" }
  ```
- 백엔드가 `ssh -L 11435:127.0.0.1:11434 desktop` 터널을 직접 열고 30초마다 상태를 확인한다. Ollama는 desktop의 127.0.0.1에만 열어 두면 된다.
- Claude Code의 시스템 프롬프트·도구 정의만 2만 토큰이 넘으므로 **Ollama 컨텍스트를 64k 이상**으로: `OLLAMA_CONTEXT_LENGTH=65536 ollama serve`.
- 모델은 직원 패널의 드롭다운(desktop에 설치된 모델 목록)에서 바꾼다. 선택은 DB에 저장된다.
- provider 직원은 `maxConcurrent`(구독 동시 실행 제한)에 포함되지 않고, provider마다 한 번에 하나만 실행된다.
- 지금은 `kind: ollama`만 지원. 다른 백엔드(예: Codex)는 `kind`를 추가하고 AgentManager에 실행기를 붙이는 식으로 확장한다.

## 구조

```
shared/protocol.ts        서버↔브라우저 메시지 타입
server/src/agents/        AgentManager(Agent SDK 세션·동시성 큐), 상태 매핑, worktree
server/src/permissions/   승인 브로커 (canUseTool → UI)
server/src/compute/       ssh / slurm 어댑터, 서버 폴링·job 추적
server/src/mcp/           에이전트용 lab 도구(GPU 서버), office 도구(비서용)
server/src/routines.ts    예약 루틴 스케줄러 (cron.ts)
web/src/game/             캔버스 도트 사무실 (스프라이트는 코드로 그린 오리지널)
web/src/ui/               공용 패널(panels.ts), 콘솔 화면(console.ts), 화면 전환(view.ts)
```

`npm test` — 단위 테스트 · `npm run typecheck` — 타입 검사

## License

MIT
