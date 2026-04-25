import HeroMessage from "@/components/HeroMessage";
import HomeGoalsView from "@/components/HomeGoalsView";
import QuickStats from "@/components/QuickStats";

export default function HomePage() {
  return (
    <>
      <HeroMessage />
      <QuickStats />
      <HomeGoalsView />
    </>
  );
}
