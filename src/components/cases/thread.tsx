import { Badge } from "@/components/ui";
import { Paperclip } from "lucide-react";
import { fmtDateTime } from "./badges";

export type ThreadMessage = {
  id: string;
  senderSide: string; // snc | agency
  senderName: string;
  body: string;
  createdAt: Date;
  files: { id: string; name: string }[];
};

// CaseMessage.fileIds(Json) → 添付リストへ変換
export function parseMessageFiles(v: unknown): { id: string; name: string }[] {
  if (!Array.isArray(v)) return [];
  return (v as { id?: unknown; name?: unknown }[])
    .filter((f) => f && typeof f.id === "string" && typeof f.name === "string")
    .map((f) => ({ id: f.id as string, name: f.name as string }));
}

// スレッド表示（§7.8: メッセージを時系列。snc側=白カード / agency側=青みカード）
export function CaseThread({ messages }: { messages: ThreadMessage[] }) {
  if (messages.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 py-8 text-center text-sm text-slate-400">
        まだメッセージはありません。
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {messages.map((m) => {
        const isAgency = m.senderSide === "agency";
        return (
          <div
            key={m.id}
            className={`rounded-xl border p-4 ${
              isAgency ? "border-blue-100 bg-blue-50" : "border-slate-200 bg-white"
            }`}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-700">{m.senderName}</span>
                <Badge tone={isAgency ? "blue" : "gray"}>{isAgency ? "代理店" : "SNC"}</Badge>
              </div>
              <span className="text-xs text-slate-400">{fmtDateTime(m.createdAt)}</span>
            </div>
            <p className="text-sm whitespace-pre-wrap text-slate-700">{m.body}</p>
            {m.files.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {m.files.map((f) => (
                  <a
                    key={f.id}
                    href={`/files/${f.id}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-blue-600 hover:bg-slate-50"
                  >
                    <Paperclip className="mr-1 inline h-3 w-3" />
                    {f.name}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
