// Everything the office characters say that is not a model's reply: greetings, remarks, banter, thoughts.
// Pure functions over `tr()`, so they follow the office language and can be tested without a browser.
import { tr } from '../../../shared/i18n.ts';
import type { EmployeeView } from '../../../shared/protocol.ts';

/** the professor, poked five times in a row, loses his temper for a while */
export const angryLines = (): string[] => [
  tr({ ko: '지금 뭐 하는 건가!', en: 'What do you think you are doing!' }),
  tr({ ko: '내가 그렇게 만만해 보이나?', en: 'Do I look like a pushover to you?' }),
  tr({ ko: '자네 졸업하기 싫은가?', en: "Don't you want to graduate?" }),
  tr({ ko: '연구는 안 하고 장난이나 치고!', en: 'Playing around instead of doing research!' }),
  tr({ ko: '당장 결과 가져오게!', en: 'Bring me results. Now!' }),
  tr({ ko: '이제부터 미팅은 매일 하지, 매일!', en: 'From now on we meet every day. Every day!' }),
  tr({ ko: '그 손가락으로 논문이나 쓰게!', en: 'Use that finger to write your paper!' }),
  tr({ ko: '내 방으로 따라오게.', en: 'Come to my office.' }),
];

/** what the professor says about the chart on the wall when you click it */
export const posterLines = (angry: boolean): string[] =>
  angry
    ? [tr({ ko: '그래프가 이게 뭔가!', en: 'What kind of chart is this!' }), tr({ ko: '이걸 그래프라고 그렸나!', en: 'You call this a chart!' })]
    : [
        tr({ ko: '이 그래프는 왜 이렇게 나왔나?', en: 'Why does this chart look like this?' }),
        tr({ ko: 'error bar는 어디 갔나?', en: 'Where are the error bars?' }),
        tr({ ko: '축 레이블이 없잖나.', en: 'There are no axis labels.' }),
        tr({ ko: 'baseline이 이것뿐인가?', en: 'Are these all the baselines?' }),
        tr({ ko: '이게 significant한가?', en: 'Is this significant?' }),
        tr({ ko: '색을 좀 바꿔 보게.', en: 'Try different colours.' }),
        tr({ ko: '마지막 막대만 높은 게 수상한데.', en: 'Only the last bar is high. Suspicious.' }),
        tr({ ko: '이걸로 Figure 1이 되겠나?', en: 'Is this supposed to be Figure 1?' }),
      ];

export const bookTitles = (): string[] => [
  tr({ ko: '졸업하는 법 (비닐도 안 뜯음)', en: 'How to Graduate (still shrink-wrapped)' }),
  tr({ ko: '교수님 저서 (사인본, 안 읽음)', en: "The professor's book (signed, unread)" }),
  tr({ ko: '3년 전에 빌린 도서관 책', en: 'A library book borrowed three years ago' }),
  tr({ ko: '선배가 두고 간 학위논문', en: 'A thesis a senior left behind' }),
  tr({ ko: 'Deep Learning (베개로 사용 중)', en: 'Deep Learning (in use as a pillow)' }),
  tr({ ko: '작년 학회 프로시딩 (기념품)', en: "Last year's proceedings (a souvenir)" }),
  tr({ ko: '연구노트 1권 (3쪽까지 씀)', en: 'Lab notebook vol. 1 (three pages used)' }),
  tr({ ko: '영어 논문 작성법 (필요한데 안 읽음)', en: 'Writing Papers in English (needed, unread)' }),
  tr({ ko: '통계학 입문 (입문만 함)', en: 'Introduction to Statistics (introduced, nothing more)' }),
  tr({ ko: '퇴사하고 싶을 때 읽는 책', en: 'A Book for When You Want to Quit' }),
];

/** from the fifth cup on, Kang and On have opinions */
export const coffeeLines = (who: 'thug' | 'counsel'): string[] =>
  who === 'thug'
    ? [
        tr({ ko: '카페인으로 논문이 써지냐, 병신아.', en: 'You think caffeine writes papers, you idiot?' }),
        tr({ ko: '손 떠는 거 봐라. 그만 처마셔.', en: 'Look at your hands shaking. Stop chugging it.' }),
      ]
    : [
        tr({ ko: '물도 한 잔 같이 드세요.', en: 'Have a glass of water with that.' }),
        tr({ ko: '오늘 잠은 주무실 수 있겠어요?', en: 'Will you be able to sleep tonight?' }),
      ];

export const paperLines = (who: 'prof' | 'thug' | 'counsel'): string[] =>
  who === 'prof'
    ? [tr({ ko: '누가 던졌나!', en: 'Who threw that!' }), tr({ ko: '지금 나한테 던진 건가?', en: 'Did you just throw that at me?' })]
    : who === 'thug'
      ? [
          tr({ ko: '뭐야 씨발, 죽을래?', en: 'What the fuck, you want to die?' }),
          tr({ ko: '한 번만 더 던져 봐.', en: 'Throw one more. I dare you.' }),
          tr({ ko: '던질 힘으로 논문을 써.', en: 'Put that arm into writing your paper.' }),
        ]
      : [
          tr({ ko: '아야… 많이 답답하셨나 봐요.', en: 'Ow… you must be really frustrated.' }),
          tr({ ko: '저한테 던지셔도 괜찮아요. 조금 풀리셨어요?', en: "It's all right to throw it at me. Feel a little better?" }),
        ];

/** Kang does not get angry: he picks the ball up and throws it back */
export const kangReturnLines = (): string[] => [
  tr({ ko: '돌려준다, 병신아.', en: 'Right back at you, idiot.' }),
  tr({ ko: '던지는 건 이렇게 하는 거다.', en: 'This is how you throw.' }),
  tr({ ko: '어디다 던져, 씨발.', en: 'Where the fuck are you throwing?' }),
  tr({ ko: '받아라.', en: 'Catch.' }),
];

/** On takes notes instead; the nth hit of the day */
export const onNote = (n: number): string =>
  n === 1
    ? tr({ ko: '(메모: 공격성 관찰됨.)', en: '(Note: aggression observed.)' })
    : n === 2
      ? tr({ ko: '(메모: 오늘 두 번째. 패턴으로 보임.)', en: '(Note: second time today. Looks like a pattern.)' })
      : n === 3
        ? tr({ ko: '(메모: 세 번째. 조준 실력은 향상 중.)', en: '(Note: third. Aim is improving.)' })
        : [
            tr({ ko: '(메모: 종이는 넉넉한 듯.)', en: '(Note: paper supply seems ample.)' }),
            tr({ ko: '(메모: 다음 상담 주제 확정.)', en: "(Note: next session's topic is settled.)" }),
            tr({ ko: '(메모: 본인은 재미있어함.)', en: '(Note: the client is enjoying this.)' }),
            tr({ ko: '(메모: 상담사의 인내심, 양호.)', en: "(Note: the counselor's patience: holding.)" }),
          ][n % 4];

/** what the working staff say when a ball of paper lands on them (one line: their bubble does not wrap) */
export const staffQuips = (id: string): string[] =>
  id === 'lit'
    ? [tr({ ko: '논문 읽는 중이었는데요…', en: 'I was reading a paper…' }), tr({ ko: '이것도 인용할까요?', en: 'Shall I cite this too?' })]
    : id === 'eval'
      ? [tr({ ko: '명중률 계산해 드릴까요?', en: 'Shall I compute your hit rate?' }), tr({ ko: '표본이 하나 늘었네요.', en: 'One more sample.' })]
      : id === 'aide1'
        ? [tr({ ko: '앗, 저 뭐 잘못했나요?', en: 'Oh! Did I do something wrong?' }), tr({ ko: '주워 드릴까요?', en: 'Shall I pick that up?' })]
        : id === 'aide2'
          ? [tr({ ko: '아야. 일 더 주시는 건가요?', en: 'Ow. Is this more work?' }), tr({ ko: '종이 재활용함은 저쪽이에요.', en: 'Paper recycling is over there.' })]
          : id === 'sec'
            ? [tr({ ko: '치우는 건 제 일이에요…', en: "I'm the one who cleans up…" }), tr({ ko: "일정표에 '종이 던지기'로 적어 둘게요.", en: "I'll put 'paper throwing' on the calendar." })]
            : id === 'exec'
              ? [tr({ ko: '지금 커밋 중인데요.', en: "I'm in the middle of a commit." }), tr({ ko: '이건 리뷰 코멘트로 받겠습니다.', en: "I'll take that as a review comment." })]
              : [tr({ ko: '…?', en: '…?' }), tr({ ko: '네?', en: 'Sorry?' })];

export const slamLines = (who: 'prof' | 'thug' | 'counsel'): string[] =>
  who === 'prof'
    ? [tr({ ko: '조용히 좀 하게.', en: 'Keep it down.' }), tr({ ko: '그 힘으로 실험을 하게.', en: 'Put that energy into your experiments.' })]
    : who === 'thug'
      ? [tr({ ko: '오, 드디어 빡쳤냐.', en: 'Oh, finally pissed off?' }), tr({ ko: '책상이 무슨 죄냐, 병신아.', en: 'What did the desk do to you, idiot?' })]
      : [
          tr({ ko: '…괜찮으세요? 손은 안 다치셨어요?', en: '…Are you all right? Did you hurt your hand?' }),
          tr({ ko: '화가 많이 나셨군요. 그럴 수 있어요.', en: "You're very angry. That's allowed." }),
        ];

export const bagMilestone = (n: number): string | null =>
  n === 10
    ? tr({ ko: '그래, 그거나 쳐라.', en: 'Yeah, go hit that.' })
    : n === 50
      ? tr({ ko: '교수 얼굴이라고 생각하고 쳐.', en: "Pretend it's the professor's face." })
      : n === 100
        ? tr({ ko: '100대? 그 끈기로 연구를 했으면 졸업했다.', en: "A hundred? With that persistence you'd have graduated." })
        : null;

export const sleepLines = (who: 'thug' | 'counsel'): string[] =>
  who === 'thug'
    ? [tr({ ko: '자냐? 그래, 자는 게 연구보다 낫겠다.', en: 'Asleep? Fine, sleeping beats your research.' }), tr({ ko: '코 고는 소리 봐라.', en: 'Listen to that snoring.' })]
    : [tr({ ko: '푹 주무세요. 깨우지 않을게요.', en: "Sleep well. I won't wake you." })];

export const caughtLines = (who: 'prof' | 'thug', angry: boolean): string[] =>
  who === 'thug'
    ? [tr({ ko: '또 딴짓하냐.', en: 'Slacking off again?' }), tr({ ko: '그럴 시간에 한 줄이라도 써라.', en: 'Write one line in that time.' })]
    : angry
      ? [tr({ ko: '지금 장난칠 땐가!', en: 'Is this the time to play around!' })]
      : [
          tr({ ko: '자네, 지금 뭐 하나?', en: 'What are you doing right now?' }),
          tr({ ko: '연구는 다 했나 보지?', en: 'So the research is all done, I take it?' }),
          tr({ ko: '한가해 보이는데, 일 하나 더 줄까?', en: 'You look free. Shall I give you one more task?' }),
        ];

/** what goes through the manager's head, picked from whatever fits the moment */
export const mutterLines = (c: { night: boolean; approvals: number; justDone: boolean; working: number; tired: boolean }): string[] => {
  const out: string[] = [];
  if (c.night) out.push(tr({ ko: '집에 가고 싶다…', en: 'I want to go home…' }), tr({ ko: '오늘도 이 시간이네.', en: 'This late again.' }));
  if (c.approvals >= 3) out.push(tr({ ko: '이걸 다 봐야 하나…', en: 'Do I have to read all of these…' }), tr({ ko: '승인 누르는 게 내 일인가.', en: 'Is pressing approve my job now?' }));
  if (c.justDone) out.push(tr({ ko: '오, 벌써?', en: 'Oh, already?' }), tr({ ko: '나보다 빠르네.', en: 'Faster than me.' }));
  if (c.working >= 3) out.push(tr({ ko: '다들 열심히네. 나만 빼고.', en: 'Everyone is hard at it. Except me.' }), tr({ ko: '구독 한도 괜찮으려나.', en: 'I hope the quota holds.' }));
  if (c.working === 0) out.push(tr({ ko: '뭘 시키지…', en: 'What should I hand out…' }), tr({ ko: '조용하네.', en: 'Quiet in here.' }));
  if (c.tired) out.push(tr({ ko: '커피…', en: 'Coffee…' }), tr({ ko: '눈이 감긴다.', en: 'My eyes are closing.' }));
  return out.length ? out : [tr({ ko: '논문 써야 하는데.', en: 'I should be writing the paper.' }), tr({ ko: '점심 뭐 먹지.', en: 'What to have for lunch.' })];
};

/** Kang says a line, On answers (when both are idle and nobody is selected) */
export const banterPairs = (night: boolean): [string, string][] => [
  [tr({ ko: '저 새끼 오늘도 논다.', en: 'That bastard is slacking again today.' }), tr({ ko: '쉬는 날도 필요해요.', en: 'Everyone needs a day off.' })],
  [tr({ ko: '쟤 졸업은 하겠냐?', en: 'Will that one ever graduate?' }), tr({ ko: '자기 속도로 가고 있어요.', en: "They're going at their own pace." })],
  [tr({ ko: '넌 왜 맨날 쟤 편이냐.', en: 'Why are you always on their side?' }), tr({ ko: '깡 씨도 걱정돼서 그러는 거잖아요.', en: "You only say that because you're worried too." })],
  [tr({ ko: '아 심심해. 누가 좀 징징대러 안 오나.', en: "I'm bored. Won't someone come and whine?" }), tr({ ko: '…그걸 기다리시는 거예요?', en: "…You're waiting for that?" })],
  [tr({ ko: '교수 또 주말에 부르겠지, 씨발.', en: 'The professor will call them in on the weekend again. Fuck.' }), tr({ ko: '그건 저도 좀 걱정이에요.', en: 'That worries me a little too.' })],
  [tr({ ko: '야, 넌 화 안 나냐?', en: "Hey, don't you ever get angry?" }), tr({ ko: '나죠. 그래서 숨을 쉬어요.', en: 'I do. That is why I breathe.' })],
  ...(night
    ? [[tr({ ko: '이 시간에 왜 아직 있냐, 저 병신은.', en: 'Why is that idiot still here at this hour?' }), tr({ ko: '집에 가라고 한마디 해 줄까요?', en: 'Shall I tell them to go home?' })] as [string, string]]
    : []),
];

/** Kang notices the plants */
export const plantJabs = (st: string[]): string[] => {
  if (st.includes('wilt')) return [tr({ ko: '화분 꼴 좀 봐라, 니 연구 같다.', en: 'Look at that plant. Just like your research.' })];
  if (st.every((x) => x === 'lush' || x === 'flower'))
    return [tr({ ko: '화분은 존나 잘 키우네. 연구를 그렇게 좀 해 봐라.', en: 'You grow plants fucking well. Try doing research like that.' })];
  return [];
};

/** after six the chat characters have evening lines instead */
export const nightGreetings = (v: EmployeeView): string[] | null =>
  v.seat === 'podium'
    ? [
        tr({ ko: '아직 있었나? 마침 잘됐네.', en: 'Still here? Good timing.' }),
        tr({ ko: '밤이 연구하기엔 제일 좋지.', en: 'Night is the best time for research.' }),
        tr({ ko: '나 때는 연구실에서 잤네.', en: 'In my day we slept in the lab.' }),
        tr({ ko: '내일 아침까지 볼 수 있지?', en: 'I can see it by tomorrow morning, right?' }),
      ]
    : v.id === 'thug'
      ? [
          tr({ ko: '이 시간까지 남아서 한 게 그거냐, 병신아?', en: "You stayed this late and that's all you did, you idiot?" }),
          tr({ ko: '집에 안 가냐? 갈 데도 없냐, 새끼야.', en: 'Not going home? Nowhere to go, dumbass?' }),
          tr({ ko: '야근한다고 일 잘하는 줄 아네, 씨발.', en: 'Thinks working late makes them good at it. Fuck.' }),
          tr({ ko: '낮에 처놀다가 이제 와서 바쁜 척하냐?', en: 'Screwed around all day and now you act busy?' }),
        ]
      : v.id === 'counsel'
        ? [
            tr({ ko: '늦게까지 계시네요. 저녁은 드셨어요?', en: "You're here late. Have you had dinner?" }),
            tr({ ko: '오늘은 여기까지만 해도 괜찮아요.', en: "It's all right to stop here for today." }),
            tr({ ko: '이 시간엔 생각이 더 무겁게 느껴지죠.', en: 'Thoughts feel heavier at this hour, don\'t they.' }),
            tr({ ko: '집에 가는 길에 숨 한번 크게 쉬세요.', en: 'Take one deep breath on your way home.' }),
          ]
        : null;

/** what is going on when someone walks up to a chat character */
export interface GreetingContext {
  /** the professor has lost his temper */
  angry: boolean;
  /** after six in the evening */
  night: boolean;
  /** the two plants' stages (Kang notices them) */
  plants: string[];
  /** cups of coffee today (from the fifth, Kang and On have opinions) */
  cups: number;
}
/** what a chat character says when you walk up to them (selected); one is picked at random each time */
export const greetings = (v: EmployeeView, c: GreetingContext): string[] =>
  v.seat === 'podium' && c.angry
    ? angryLines()
    : [
        ...((c.night && nightGreetings(v)) || dayGreetings(v)),
        ...(v.id === 'thug' ? plantJabs(c.plants) : []),
        ...((v.id === 'thug' || v.id === 'counsel') && c.cups >= 5 ? [coffeeLines(v.id)[0]] : []),
      ];
export const dayGreetings = (v: EmployeeView): string[] =>
  v.seat === 'podium'
    ? [
        tr({ ko: '음, 그래서 결과는 나왔나?', en: 'So, any results yet?' }),
        tr({ ko: '마침 잘 왔네, 할 얘기가 있었는데.', en: 'Good timing, I had something to discuss.' }),
        tr({ ko: '지난주에 얘기한 건 어떻게 됐나?', en: 'How is the thing we talked about last week going?' }),
        tr({ ko: '오는 길에 재미있는 생각이 하나 났는데.', en: 'I had an interesting thought on the way in.' }),
        tr({ ko: '요즘 얼굴 보기 힘드네.', en: "I don't see you around much these days." }),
        tr({ ko: '그 실험, 금방 하지?', en: "That experiment won't take long, right?" }),
        tr({ ko: '주말에 잠깐 볼까?', en: "Let's talk briefly this weekend." }),
        tr({ ko: '논문은 언제쯤 볼 수 있나?', en: 'When can I see the paper?' }),
      ]
    : v.id === 'thug'
      ? [
          tr({ ko: '하… 한심한 새끼 또 왔네.', en: 'Ugh. The pathetic bastard is back.' }),
          tr({ ko: '뭘 봐 새끼야, 할 일 없냐?', en: 'What are you looking at, dumbass? Nothing to do?' }),
          tr({ ko: '또 징징대러 왔냐? 존나 지겹다 진짜.', en: "Here to whine again? I'm so fucking tired of you." }),
          tr({ ko: '니가 그러니까 졸업을 못 하는 거야, 병신아.', en: "This is exactly why you can't graduate, you idiot." }),
          tr({ ko: '논문 한 줄도 안 쓴 새끼가 여긴 왜 와.', en: 'Not one line of the paper written, and you show up here?' }),
          tr({ ko: '에휴, 그 대가리로 대학원은 어떻게 왔냐.', en: 'How the hell did you get into grad school with that brain?' }),
          tr({ ko: '변명 들어 줄 시간 없다, 꺼져.', en: 'No time for your excuses. Piss off.' }),
          tr({ ko: '오늘은 또 뭘 말아먹었냐, 씨발.', en: 'So what did you fuck up today?' }),
        ]
      : v.id === 'counsel'
        ? [
            tr({ ko: '오늘 하루 어땠어요?', en: 'How was your day?' }),
            tr({ ko: '어서 오세요. 오늘은 어떤 마음으로 오셨어요?', en: 'Welcome. What brings you here today?' }),
            tr({ ko: '요즘 잠은 좀 주무세요?', en: 'Have you been sleeping lately?' }),
            tr({ ko: '지난번 이후로 어떻게 지내셨어요?', en: 'How have you been since last time?' }),
            tr({ ko: '천천히 말씀하셔도 돼요.', en: 'Take your time.' }),
            tr({ ko: '오늘 가장 마음에 걸리는 게 뭐예요?', en: "What's weighing on you most today?" }),
            tr({ ko: '여기 앉아서 숨 한번 고르고 가세요.', en: 'Sit down and catch your breath for a moment.' }),
            tr({ ko: '밥은 챙겨 드셨어요?', en: 'Have you eaten?' }),
          ]
        : [tr({ ko: '무슨 일 있어?', en: "What's up?" })];
