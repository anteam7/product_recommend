/**
 * 한국어 조사 자동 선택.
 * 마지막 글자의 받침(종성) 유무로 결정한다.
 *
 * @param word 앞 단어
 * @param pair "받침있을때/받침없을때" 형식. 예: "은/는", "을/를", "와/과", "이/가"
 * @example josa('이지타오', '은/는') === '는'
 * @example josa('아이포터', '와/과') === '와'
 * @example josa('짐패스', '은/는') === '는'  // '스' = 받침 없음
 */
export function josa(word: string, pair: string): string {
  const [withFinal, withoutFinal] = pair.split('/')
  if (!word) return withoutFinal

  const last = word.charCodeAt(word.length - 1)
  // 한글 음절: U+AC00 ~ U+D7A3
  if (last >= 0xac00 && last <= 0xd7a3) {
    const hasFinal = (last - 0xac00) % 28 !== 0
    return hasFinal ? withFinal : withoutFinal
  }

  // 숫자 끝일 때: 한국어 발음 기준
  // 0(영)·1(일)·3(삼)·6(육)·7(칠)·8(팔)·9(구) → 모음 끝 / 받침 없음? 실제로:
  //   0 영(받침O), 1 일(받침O), 2 이(없), 3 삼(O), 4 사(없), 5 오(없),
  //   6 육(O), 7 칠(O), 8 팔(O), 9 구(없)
  if (last >= 0x30 && last <= 0x39) {
    const n = String.fromCharCode(last)
    const withFinalDigits = new Set(['0', '1', '3', '6', '7', '8'])
    return withFinalDigits.has(n) ? withFinal : withoutFinal
  }

  // 영문/기타: 알파벳 마지막이 자음 비슷하면 받침 있다고 간주
  const lastChar = word[word.length - 1].toLowerCase()
  if (/[a-z]/.test(lastChar)) {
    const consonantEnding = !'aeiouwy'.includes(lastChar)
    return consonantEnding ? withFinal : withoutFinal
  }

  return withoutFinal
}
