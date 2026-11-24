[English](README.md) | **한국어**

[![CI](https://github.com/turtle505/eightbit-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/turtle505/eightbit-lab/actions/workflows/ci.yml)

# 👾 8-bit Lab

**AI 에이전트들이 일하는 픽셀아트 사무실.** 8-bit Lab은 Claude Code 에이전트("직원") 여러 명을 동시에 돌리고, 각자 책상에서 일하는 작은 캐릭터로 보여줍니다. 나는 매니저입니다. 일을 나눠 주고, 위험한 작업은 승인하고, 보고를 받습니다.

**그냥 터미널에서 `claude`를 여러 개 띄우면 안 되나요?** 여기서는 관리할 수 있는 팀으로 일합니다. 하려는 작업을 한곳에서 승인하고, 어떤 일을 누가 맡았는지 보드로 보고, GPU job이 끝나면 알아서 보고가 오고, 보고서가 한 피드에 모입니다. 터미널 탭을 오가는 대신 사무실을 지켜보면 됩니다.

연구실에서 시작해서 원격 GPU 서버에 job을 올리고 지켜보는 기능도 있지만, 특정 분야를 전제하지 않습니다. 우리 팀이 하는 일을 한 줄로 알려 주면 직원들이 거기에 맞춰 일합니다.

- 🧑‍💻 **기본 직원 6명**: 문헌 리서처, 평가 분석가, 연구 보조 둘, 비서, 그리고 다른 직원에게 일을 나눠 줄 수 있는 실행 팀장.
- 👀 **누가 뭘 하는지 한눈에**: 타이핑 중인지, 명령을 실행 중인지, 웹을 찾는 중인지, 내 승인을 기다리는지.
- ✋ **통제권은 나에게**: 원격 서버에 닿는 작업은 항상 먼저 묻고, 그 밖에 애매한 작업은 승인 카드로 올라오며, 🔒 작업은 모든 도구를 묻습니다([안전장치](#안전장치) 참고).
- 📨 **보고가 알아서 도착**: 끝난 일과 저장된 보고서가 채팅처럼 피드에 쌓입니다.
- ⏰ **루틴**: "평일 9시마다 새 논문 브리핑해줘" — 비서에게 말만 하면 됩니다.
- 🖥️ **GPU job**: ssh·Slurm 서버에 job을 올리고, 지켜보고, 결과를 가져옵니다. job이 끝나면 올린 직원이 결과를 보고합니다.
- 🌐 **한국어 / 영어**: 버튼 하나로 사무실 전체 언어를 바꿉니다.

내 컴퓨터에서 로컬로 돌고, `claude` CLI 로그인을 통해 내 **Claude Pro/Max 구독**을 씁니다. API 키는 필요 없습니다.

> **상태:** 매일 쓰고 있지만 아직 어린 개인 프로젝트라 거친 부분이 있을 수 있습니다. Anthropic과 관계없는 비공식 프로젝트입니다.

---

## 빠른 시작

### 준비물

- **Node.js 22.13 이상** (24 권장): 내장 `node:sqlite`를 쓰는데, 그보다 낮은 버전에서는 플래그를 켜야만 쓸 수 있습니다. nvm을 쓴다면 `nvm use`로 맞는 버전이 잡히고(`.nvmrc`), 버전이 낮으면 `npm start`가 분명한 안내와 함께 멈춥니다.
- **Claude Code CLI**에 Pro 또는 Max 요금제로 로그인. `claude`를 한 번 실행해 로그인하고, `claude --version`으로 확인하세요.
- macOS 또는 Linux. macOS에서는 Word/RTF 첨부를 자동으로 텍스트로 바꿔 줍니다.

### 실행

```bash
git clone https://github.com/turtle505/eightbit-lab.git
cd eightbit-lab
npm install
npm run dev
```

**http://localhost:5173** 을 여세요. 끝입니다. 시작하는 데 설정은 필요 없습니다.

> 화면이 영어로 나오면 오른쪽 위 **한국어** 버튼을 누르세요. 선택은 기억됩니다.

### 처음 5분

1. **직원을 클릭**하고(또는 <kbd>1</kbd>–<kbd>6</kbd>) 아래 입력칸에 지시를 적습니다. 예: *"retrieval-augmented generation 최신 논문 3편 찾아서 요약해줘."*
2. 일하는 모습을 지켜보세요. 말풍선에 지금 하는 일이 나옵니다.
3. **`!`를 띄우고 손을 들면** 내 허락이 필요하다는 뜻입니다. 노란 승인 패널에서 승인하거나 거부하세요.
4. 끝나면 답이 **📨 보고** 피드에 도착합니다(데스크톱 알림을 켜 두면 알림도 옵니다).

큰 일은 작업 보드에 **카드**를 추가하고 직원에게 끌어다 놓으세요. 끝난 카드는 보고서와 함께 *검토*로 넘어옵니다.

> 💡 직원마다 첫 지시는 세션을 여느라 몇 초 걸립니다. 그다음부터는 거의 바로 시작합니다.

---

## 평소에 쓰는 법

| 하고 싶은 것 | 방법 |
|---|---|
| 지시하기 | 직원 클릭 → 입력칸에 입력 |
| 작업 배정 | 작업 보드에 카드 추가 → 직원에게 드래그 (또는 카드의 드롭다운) |
| 승인 / 거부 | 노란 승인 패널 (콘솔 화면에서는 <kbd>a</kbd> / <kbd>d</kbd>) |
| 결과 확인 | 끝난 카드는 **검토**로 이동 → **보고** 펼쳐 보고 **완료** |
| 지난 보고서 | **보고서** 탭: 모든 `.md` 보고서를 폴더 트리로, 안 읽은 개수와 함께 |
| 멈추기 | 직원 패널의 **중지** (지금 턴만 끝내고 대화는 유지) |
| 새로 시작 | 직원 패널의 **새 세션** (대화를 비움) |
| 반복 작업 예약 | 루틴 패널 → **+ 새 루틴**, 또는 비서에게 부탁 |
| 화면 전환 | 오른쪽 위 **게임 / 콘솔 / 보고서 / 프로젝트**, 또는 <kbd>`</kbd> |
| 언어 전환 | 오른쪽 위 **EN / 한국어** 버튼 |

**화면.** *게임*은 픽셀 사무실입니다. *콘솔*은 같은 데이터를 표로 보여줍니다(직원, 작업, 전체 활동 피드, 승인). 키보드로 다 다룰 수 있습니다. *보고서*는 보고서 파일 읽기용입니다. URL에 `?view=console`, `?view=reports`를 붙이면 바로 열립니다.

**키보드** (콘솔): <kbd>1</kbd>–<kbd>6</kbd> 선택 · <kbd>j</kbd>/<kbd>k</kbd> 이동 · <kbd>/</kbd> 지시 · <kbd>a</kbd>/<kbd>d</kbd> 승인/거부 · <kbd>Esc</kbd> 해제.

**캐릭터가 뜻하는 것**

| 보이는 모습 | 뜻 |
|---|---|
| ☕ 휴게 공간 | 쉬는 중 |
| 책상에서 타이핑 | 일하는 중. 모니터가 파랑이면 편집, 초록이면 명령 실행, 하늘색이면 웹 검색 |
| `...` | 생각 중 |
| ✋ `!` 띄우고 손 듦 | 내 승인 대기 |
| ✨ 반짝임 | 방금 끝남 |

**구독 사용량.** 상단 바에 Claude 요금제의 **5시간·주간 사용량**과 초기화 시각이 나옵니다. 직원 패널의 숫자는 한도 대비 %가 아니라 사무실 전체 사용량 중 *그 직원의 몫*입니다. 일하다 5시간 한도가 다 차면 직원이 멈췄다가 **초기화되면 알아서 이어서** 합니다. 기다리기 싫으면 **▶️ 지금 이어서**를 누르세요.

---

## 내 환경에 맞추기

설정은 모두 `config/`에 있습니다. **개인 설정은 커밋된 파일을 고치지 말고** 옆에 `config/<이름>.local.yaml`로 두세요. git에서 제외되고, 기본 파일 위에 덮어씁니다.

- `office.local.yaml`은 키 단위로 덮어씁니다.
- 직원·루틴·서버 목록은 같은 `id`(서버는 `name`)면 기본값을 바꾸고, 새 항목은 추가합니다.

```yaml
# config/office.local.yaml (흔한 예)
domain: "a computer-vision lab working on video understanding"   # 우리 팀이 하는 일, 한 줄 (영어 권장: 프롬프트가 영어)
language: ko              # ko | en: 화면 언어이자 직원들이 보고하는 언어
maxConcurrent: 3          # 동시에 일하는 직원 수 (구독 rate limit 보호)
researchRepo: ~/research/my-model   # 선택: 엔지니어마다 이 저장소의 git worktree를 따로 줌
authToken: ""             # 선택: 사무실에 비밀번호 걸기 ("안전장치" 참고)
```

| 파일 | 하는 일 |
|---|---|
| `config/office.yaml` | 우리 분야(`domain`), 동시 실행 수, 모델, 언어, 유휴 시간, 호스트, 로컬 모델 |
| `config/roles.yaml` | 직원: 이름, 역할 프롬프트, 승인 없이 쓸 도구(`autoAllow`), 캐릭터 색 |
| `config/routines.yaml` | 시작용 루틴: 평일 09:00 아침 브리핑, 평일 18:00 저녁 리포트, 금 17:00 주간 회고(꺼짐) |
| `config/servers.local.yaml` | 내 GPU 서버 (`servers.example.yaml` 복사) |

**작업 폴더.** `researchRepo`를 정하면 엔지니어마다 자기 git worktree(브랜치 `office/<id>`)에서 일하므로 서로 충돌하지 않습니다. 정하지 않으면 모두 `workspaces/shared`를 같이 씁니다. 보고서는 `workspaces/<직원>/reports/`에 쌓입니다.

**팀.**

| id | 누구 | 하는 일 |
|---|---|---|
| `lit` | Ada | 논문·웹 리서치 |
| `eval` | Gauss | 지표 계산, 그림, 평가 보고서 |
| `aide1`, `aide2` | Finn, Mira | 넘겨받은 일은 뭐든 하는 연구 보조 |
| `sec` | Hana | 비서: 루틴, 사무실 현황, 보고서 정리 |
| `exec` | Linus 👑 | 실행 팀장: 직접 구현하고 GPU job을 돌리며 다른 직원에게 일을 나눔 |

**우리 분야에 맞추기.** 보통은 `domain`만 정하면 충분합니다. 모든 직원의 프롬프트가 `About this team: <domain>`으로 시작합니다. 더 맞추고 싶으면(예: 평가 분석가가 우리 분야 지표를 알게, 리서처가 설치해 둔 논문 검색 MCP 서버를 쓰게) `config/roles.local.yaml`에서 그 직원을 덮어쓰세요. `id`로 찾아 항목별로 합쳐집니다.

```yaml
# config/roles.local.yaml
employees:
  - id: lit
    autoAllow: [Read, Glob, Grep, WebSearch, WebFetch, Write, Edit, TodoWrite, mcp__arxiv]   # + 내 MCP 서버
  - id: eval
    systemPrompt: |
      ## Your role: Evaluation Analyst
      You compute and interpret mAP, IoU and per-class recall for our detection models …
```

각 역할 프롬프트 앞에는 `roles.yaml`의 `common:` 블록(정직하게 보고하기, 바꾸기 전에 읽기, 보고 형식)이 공통으로 붙고, GPU 서버나 원격 호스트가 있으면 `servers:` 블록(원격 서버 예절)도 붙습니다. 직원을 빼도 그 직원의 작업 카드는 사라지지 않고 *미배정*으로 돌아갑니다.

**언어.** 직원들이 받는 지시는 늘 영어이고, *보고하는* 언어만 설정을 따릅니다. 헤더 버튼이 `language:`보다 우선하며 기억됩니다. 이미 쌓인 로그와 피드는 쓰인 언어 그대로 남고, 이미 저장된 루틴은 다시 번역되지 않습니다.

**비서와 루틴 만들기.** Hana에게 *"매주 금요일 5시에 이번 주 다들 뭐 했는지 정리해줘"*라고 말하세요. 몇 가지 물어본 뒤 순서를 **사무실 스킬**(`workspaces/office-skills/skills/<이름>/SKILL.md`)로 적어 두고, 그걸 실행하는 루틴을 등록합니다. 스킬에는 승인 없이 실행할 명령(`office-allow`)을 적을 수 있습니다. 단, 파일이 내가 승인한 내용 그대로일 때만입니다. 바뀌면 루틴 패널에 **⚠️ 재승인 필요**가 뜹니다. 루틴은 5필드 cron, 백엔드가 도는 기기의 현지 시각 기준이며, 백엔드가 켜져 있을 때만 돕니다.

---

## 추가 기능

<details>
<summary><b>🖥️ GPU 서버 (job 올리고 추적하기)</b></summary>

`config/servers.example.yaml`을 `config/servers.local.yaml`로 복사해 서버를 적습니다. 서버마다 `type: ssh` 또는 `type: slurm`과 `~/.ssh/config`의 `ssh_host` 별칭을 적는데, **비밀번호 없이 키로 접속돼야** 합니다. 백엔드가 그 기기에서 돈다면 `ssh_host: local`로 두세요.

그러면 직원들이 `mcp__lab__*` 도구를 씁니다: `list_servers`, `gpu_status`, `submit_job`, `job_status`, `tail_log`, `cancel_job`, `fetch_results`. job은 job 패널에 나오고, 끝나면 올린 직원이 자동으로 알림을 받아 결과를 보고합니다.
</details>

<details>
<summary><b>📁 프로젝트 세션 (아무 폴더에서 Claude Code 세션)</b></summary>

**프로젝트** 탭에서 호스트와 이미 있는 폴더를 고르면 그 폴더에서 Claude Code 세션이 열립니다. `ssh host`, `cd ~/project/x`, `claude`와 같지만 승인·로그·보고가 붙습니다. 한 프로젝트에서 서로 독립된 세션을 여러 개 돌릴 수 있습니다.

- 세션은 탭 안에만 있습니다. **사무실에 들이기**를 누르면 책상과 캐릭터가 생깁니다.
- 직원과 같은 승인 규칙을 따르고, `maxConcurrent`에도 포함됩니다.
- 세션을 닫으면 대화는 버려지고 파일은 남습니다.
</details>

<details>
<summary><b>🌍 다른 기기에서 세션 돌리기 / 백엔드 옮기기</b></summary>

`office.local.yaml`의 `hosts`에 기기를 적고, 직원이나 프로젝트에 `host: <id>`를 주세요.

```yaml
hosts:
  - { id: desktop, name: "🖥 desktop", ssh: local, projectRoot: "~/project" }
  - { id: gpu1, name: "🧮 gpu1", ssh: gpu1, projectRoot: "~/project", claudePath: "/home/me/.local/bin/claude" }
```

- `ssh: local`은 백엔드가 도는 기기입니다. 나머지는 ssh 별칭(키 인증)입니다.
- 기기마다 `claude` 설치와 로그인이 필요합니다. 비대화형 ssh에는 보통 `~/.local/bin`이 PATH에 없으므로 `claudePath`는 **절대 경로**로 적으세요.
- 원격 세션은 첨부 파일을 못 읽습니다(백엔드 디스크에 있으므로).
- 대화는 그걸 돌린 기기에만 있어서, 직원을 다른 기기로 옮기면 새 세션으로 시작합니다.

**공용 서버는 접속이 잦은 클라이언트를 싫어하므로** 사무실은 ssh를 아껴 씁니다.

- 짧은 명령은 호스트당 연결 하나를 같이 씁니다.
- 연결되는 호스트는 한 번만 확인하고 그 뒤로는 건드리지 않습니다.
- 호스트마다 분당 `sshPerMinute`회(기본 5, `hosts` 항목에서 호스트별로 지정, `0` = 무제한)의 접속 예산이 있습니다. 직원이 직접 실행하는 `ssh`/`scp`/`rsync`도 여기에 포함됩니다. 예산을 넘으면 "N초 뒤 다시 시도" 안내와 함께 거부됩니다.
- 예산이 거의 다 차면 호스트 배지에 ⏳가 뜹니다.

**백엔드를 서버로 옮기기:** `git clone` → `npm ci` → `npm run build` → `deploy/eightbit-lab.service` 참고. 작업·루틴·첨부를 그대로 가져가려면 `data/office.db`와 `workspaces/`를 복사하세요. 백엔드를 두 곳에서 동시에 돌리면 루틴이 두 번 돌므로 하나만 켜 두세요.

**나중에 업데이트할 때:** 그 컴퓨터에서 `npm run update`. 일하는 직원이 없는지 먼저 확인하고(재시작하면 하던 일이 끊기므로), pull → 빌드 → systemd 서비스 재시작까지 해 줍니다. 확인을 건너뛰려면 `npm run update -- --force`.
</details>

<details>
<summary><b>✅ Obsidian 오늘 할 일</b></summary>

볼트를 지정하면 **✅ 오늘 할 일** 패널에 오늘 데일리 노트의 체크박스가 나옵니다. 체크, 수정(더블클릭), 추가, 삭제가 되고, 변경은 노트 파일에 바로 쓰이며 Obsidian에서 고친 내용도 몇 초 안에 반영됩니다. 그사이 Obsidian에서 그 줄이 바뀌었으면 덮어쓰지 않고 거부합니다.

```yaml
obsidian:
  vault: /path/to/vault
  daily: "{YYYY}-{MM}-{DD}.md"     # Obsidian 기본값. 연도별 폴더면 예: "Daily/{YYYY}/{YYYY}.{MM}.{DD}.{ddd}.md"
  # sections: [Today, Projects]    # 이 "## " 제목만 읽기 (기본: 전부)
  # schedule: [Schedule, 일정]      # 일반 bullet(약속)도 보여줄 일정 제목
```

평범한 노트면 됩니다: `## ` 제목 아래의 `- [ ]`가 제목별로 묶여 나오고, 제목이 없는 노트는 통째로 한 목록으로 읽습니다. 선택적으로, **굵은 글씨만 있는 줄**은 섹션 안의 이름 붙은 묶음이 되고, 항목 끝의 `↻3`은 "3번 이월됨"으로 표시됩니다.
</details>

<details>
<summary><b>📎 첨부 파일</b></summary>

작업 폼의 📎이나 직원 입력칸에 파일을 끌어다 놓으세요(파일당 50 MB까지). 직원은 지시와 함께 파일 경로를 받습니다.

- CSV, 텍스트, JSON, 이미지, PDF는 그대로 읽습니다.
- macOS에서는 Word, RTF, ODT, HTML에 `.txt` 변환본도 함께 만들어집니다.
- 엑셀은 pandas로 읽습니다.
- 어디에도 붙이지 않은 업로드는 24시간 뒤 지워집니다.
</details>

<details>
<summary><b>🦙 로컬 모델(Ollama)로 일하는 직원</b></summary>

어떤 직원이든 구독 대신 Ollama 모델로 돌릴 수 있습니다. 요약이나 메모 같은 가벼운 일에 좋습니다. provider는 `office.local.yaml`에 추가하고, `roles.local.yaml`에서 직원이 그걸 쓰게 하세요.

```yaml
# config/office.local.yaml
providers:
  - { id: workstation, name: "🖥 workstation", kind: ollama, ssh_host: workstation, remotePort: 11434, localPort: 11435, model: "qwen3:8b" }
```

```yaml
# config/roles.local.yaml
employees:
  - { id: aide2, provider: workstation }
```

- ssh 터널은 사무실이 직접 열고 상태를 확인합니다.
- Claude Code 자체 프롬프트가 2만 토큰이 넘으므로 Ollama는 **64k 이상 컨텍스트**로 띄우세요(`OLLAMA_CONTEXT_LENGTH=65536 ollama serve`).
- 모델은 직원 패널에서 고릅니다.
- 이런 직원은 `maxConcurrent`에 포함되지 않습니다.
</details>

---

## 안전장치

에이전트는 믿을 수 없는 웹 페이지나 논문도 읽기 때문에 몇 가지 안전장치를 켜 둡니다.

- **기본은 자동 모드.** 직원은 **🤖 자동**으로 일합니다. 분류기가 확실히 안전한 도구 호출은 바로 허용하고, 애매한 것만 승인 카드로 올립니다. 전부 직접 승인하려면 그 직원을 **✋ 승인**으로 바꾸세요.
- **랩 서버는 항상 물어봅니다.** 다른 기기로 job을 올리거나 취소하거나 결과를 가져오는 것, 그리고 모든 `ssh`/`scp`/`rsync`/`sftp` 명령은 자동 모드여도 승인 카드가 뜹니다. 웹 페이지에 숨은 지시 하나로 GPU 서버에서 명령이 실행되는 일을 막기 위해서입니다. 읽기 전용 확인(GPU 상태, job 상태, 로그)은 묻지 않습니다.
- **작업별 🔒.** 작업 카드에 🔒를 체크하면 그 작업은 직원의 허용 목록 밖 도구마다 승인을 받습니다.
- **로컬 전용.** 백엔드는 `127.0.0.1`에서만 듣고 다른 출처의 브라우저 요청은 거부하므로, 내가 열어 둔 아무 웹 페이지가 사무실을 조종할 수 없습니다.
- **비밀번호(선택).** 다른 사람도 이 기기에 로그인할 수 있다면 `office.local.yaml`에 `authToken`을 넣으세요. 브라우저는 한 번 입력하면 쿠키로 기억하고, 스크립트는 `X-Office-Token: <token>` 헤더를 보냅니다.

---

## 문제 해결

| 증상 | 해 볼 것 |
|---|---|
| 사용량이 "—"로 나옴 | 사용량 조회는 실험적 API라 안 될 수 있습니다. 나머지 기능은 그대로 됩니다 |
| 직원이 ⏸ **사용량 한도** | 5시간 한도가 찼습니다. 표시된 시각에 알아서 이어서 하고, 바로 하려면 ▶️ **지금 이어서** |
| 직원이 멈춘 것 같음 | 패널에서 로그를 확인하고 **중지** 후 다시 지시. 대화가 꼬였으면 **새 세션** |
| 호스트 배지가 연결 안 됨 | `ssh <별칭>`이 비밀번호 없이 되는지 확인하고 배지의 ↻ |
| 새 도구나 옵션이 안 먹음 | 오래 열린 세션은 도구 목록을 캐시합니다: **새 세션** |

---

## 개발자용

```bash
npm run dev         # 백엔드 (tsx watch, :8787) + Vite (:5173)
npm run build && npm start   # 배포: 백엔드가 dist/를 127.0.0.1:8787에서 서빙
npm test            # 단위 테스트 (vitest)
npm run typecheck
```

```
shared/protocol.ts     서버↔브라우저 메시지 전부
shared/i18n.ts         ko/en 전환: tr({ ko, en }), 로케일 헬퍼
server/src/agents/     AgentManager: 직원마다 오래 열린 Agent SDK 세션 하나, 대기열, 권한
server/src/compute/    ssh / slurm 어댑터, 서버 폴링, job 추적
server/src/mcp/        에이전트 도구: lab (GPU 서버), office (비서용)
web/src/game/          픽셀 사무실 (스프라이트는 코드로 그림)
web/src/ui/            패널, 콘솔, 보고서, 프로젝트
```

구조는 [CLAUDE.md](CLAUDE.md)에 자세히 있습니다. 데이터는 `data/office.db`(SQLite)와 `workspaces/`에 있고, 둘 다 git에서 제외됩니다.

## License

MIT
