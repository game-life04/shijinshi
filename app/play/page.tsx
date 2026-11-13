import AppShell from "@/components/AppShell";
import Play from "@/components/Play";

export default function PlayPage() {
  return (
    <AppShell active="/play" fill="always">
      <Play />
    </AppShell>
  );
}
