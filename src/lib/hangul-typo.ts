// 한글 두벌식 자판 → QWERTY 위치 변환.
// 사용자가 한글로 입력하려다 영문 모드인 채로 입력한 결과를 재현.
// 예: '포스트고' → 'vhtmxmrh', '조이포스트' → 'whdlvhtmxm'
// GSC에 노출 100+ 잡히는 한영 자판 오타 검색어 매칭용.

const INITIAL_QWERTY: readonly string[] = [
  'r', 'R', 's', 'e', 'E', 'f', 'a', 'q', 'Q', 't',
  'T', 'd', 'w', 'W', 'c', 'z', 'x', 'v', 'g',
]
const MEDIAL_QWERTY: readonly string[] = [
  'k', 'o', 'i', 'O', 'j', 'p', 'u', 'P', 'h', 'hk',
  'ho', 'hl', 'y', 'n', 'nj', 'np', 'nl', 'b', 'm', 'ml', 'l',
]
const FINAL_QWERTY: readonly string[] = [
  '', 'r', 'R', 'rt', 's', 'sw', 'sg', 'e', 'f', 'fr',
  'fa', 'fq', 'ft', 'fx', 'fv', 'fg', 'a', 'q', 'qt', 't',
  'T', 'd', 'w', 'c', 'z', 'x', 'v', 'g',
]

export function koreanToQwertyTypo(input: string): string {
  let out = ''
  let hasHangul = false
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0xac00 && code <= 0xd7a3) {
      hasHangul = true
      const offset = code - 0xac00
      const initial = Math.floor(offset / 588)
      const medial = Math.floor((offset % 588) / 28)
      const final = offset % 28
      out += INITIAL_QWERTY[initial] + MEDIAL_QWERTY[medial] + FINAL_QWERTY[final]
    } else {
      out += ch
    }
  }
  return hasHangul ? out : ''
}
