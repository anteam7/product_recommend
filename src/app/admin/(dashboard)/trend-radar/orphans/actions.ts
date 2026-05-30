"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/adminserver";
import { createClient } from "@/lib/supabase/server";

export type PromoteResult = { ok: boolean; productId?: number; error?: string };

/**
 * 미발굴 키워드를 canonical product + alias(manual, confidence=1) 로 승격.
 * 다음 recompute(daily 집계)부터 점수화되어 리더보드에 등장한다.
 */
export async function promoteOrphan(
  keyword: string,
  category: string | null,
): Promise<PromoteResult> {
  if (!keyword?.trim()) return { ok: false, error: "키워드가 비었습니다." };

  // 인증 확인 (어드민 세션) — 우회 금지
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "인증이 필요합니다." };

  // RLS 우회 쓰기는 서비스 롤로 (RPC 가 products/aliases insert)
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("jimscanner_orphan_promote" as never, {
    p_keyword: keyword,
    p_category: category,
  } as never);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin/trend-radar/orphans");
  revalidatePath("/admin/trend-radar");
  return { ok: true, productId: data as unknown as number };
}
