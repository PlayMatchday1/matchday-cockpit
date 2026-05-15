import AdminGuard from "@/components/AdminGuard";
import ChatThreadClient from "./ChatThreadClient";

type PageProps = { params: Promise<{ chatId: string }> };

export default async function MatchChatDetailPage({ params }: PageProps) {
  const { chatId } = await params;
  return (
    <AdminGuard>
      <ChatThreadClient chatId={chatId} />
    </AdminGuard>
  );
}
