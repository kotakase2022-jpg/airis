import Link from "next/link";

// 404（ページ不存在）。権限拒否（/dashboard?denied=... のバナー）とは明確に区別する
// （検収指摘 問題一覧No.34: 404か権限拒否か判別できない問題への対応）
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F5F7FB] p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mb-2 text-4xl font-bold text-slate-300">404</div>
        <h1 className="mb-2 text-lg font-bold text-slate-800">ページが見つかりません</h1>
        <p className="mb-6 text-sm leading-relaxed text-slate-500">
          URLが誤っているか、ページが移動・削除された可能性があります。
          （権限が不足している場合はこの画面ではなく、ダッシュボード上部にその旨が表示されます）
        </p>
        <Link
          href="/dashboard"
          className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          ダッシュボードへ戻る
        </Link>
      </div>
    </div>
  );
}
