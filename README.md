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
| 중지 / 새 세션 | 직원 패널의 `중지`, `새 세션` (세션은 기본적으로 이어짐) |
| 예약 업무 | 루틴 패널: 켜기/끄기, `지금 실행` (일정은 `config/routines.yaml`) |

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
- `config/routines.yaml` — 예약 루틴 (cron 5필드, 이 Mac 현지 시간, 백엔드가 켜져 있을 때만 실행)
  - 기본: 평일 09:00 아침 브리핑, 평일 18:00 저녁 일일 리포트 (켜짐) · 금 17:00 주간 회고, 평일 08:30 Obsidian 데일리 노트 (꺼짐)
- `config/servers.local.yaml` — GPU 서버 (`servers.example.yaml` 복사, git 제외). 서버마다 `type: ssh | slurm`
  - `ssh_host`는 `~/.ssh/config` alias, **비밀번호 없이(키 인증) 접속돼야 함**
  - 직원은 `mcp__lab__*` 도구(list_servers, gpu_status, submit_job, job_status, tail_log, cancel_job, fetch_results)로 서버를 사용
  - job이 끝나면 제출한 직원에게 자동으로 알려 결과를 보고하게 함

## 비서 직원 (Hana)

매니저 책상 옆 리셉션 자리. `mcp__office__*` 도구로 사무실 전체를 본다:
`office_status`(직원·job·서버 현황), `list_tasks`, `office_activity`(최근 N시간 직원별 활동), `list_routines`, `create_task`(다른 직원에게 위임).
위임(`create_task`)은 기본적으로 **매니저 승인 필요**. 리포트는 `workspaces/secretary/reports/` 에 저장된다.

직원 세션에서는 claude.ai 연동(Gmail, Google Calendar 등)이 보이지 않는다. 쓸 수 있는 것은 로컬 플러그인 MCP(PubMed, bioRxiv 등)와 skill(daily-note 등)이다.

## 구조

```
shared/protocol.ts        서버↔브라우저 메시지 타입
server/src/agents/        AgentManager(Agent SDK 세션·동시성 큐), 상태 매핑, worktree
server/src/permissions/   승인 브로커 (canUseTool → UI)
server/src/compute/       ssh / slurm 어댑터, 서버 폴링·job 추적
server/src/mcp/           에이전트용 lab 도구(GPU 서버), office 도구(비서용)
server/src/routines.ts    예약 루틴 스케줄러 (cron.ts)
web/src/game/             캔버스 도트 사무실 (스프라이트는 코드로 그린 오리지널)
web/src/ui/               작업 보드, 승인, 직원 로그, 서버실 패널
```

`npm test` — 단위 테스트 · `npm run typecheck` — 타입 검사

## License

MIT
