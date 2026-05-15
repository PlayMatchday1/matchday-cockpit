import { redirect } from "next/navigation";

// Legacy route. The two-pane shell at /match-chats?chatId=… replaces
// the standalone detail page. We keep this here so existing
// bookmarks and any in-app links still route to the right thread,
// and we redirect server-side so there's no client-flash.

type PageProps = { params: Promise<{ chatId: string }> };

export default async function LegacyMatchChatDetailPage({
  params,
}: PageProps) {
  const { chatId } = await params;
  redirect(`/match-chats?chatId=${encodeURIComponent(chatId)}`);
}
