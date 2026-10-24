import { createFileRoute, redirect } from "@tanstack/react-router";
import { TeamWorkPage } from "../components/teamWork/TeamWorkPage";

export const Route = createFileRoute("/team-work")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
  },
  component: TeamWorkPage,
});
