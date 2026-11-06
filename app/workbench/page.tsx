import AppShell from "@/components/AppShell";
import Workbench from "@/components/Workbench";

export default function WorkbenchPage() {
  return (
    <AppShell active="/workbench" fill>
      <Workbench />
    </AppShell>
  );
}
