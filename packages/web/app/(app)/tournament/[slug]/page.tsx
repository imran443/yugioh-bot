"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { useTournamentWebsocket } from "@/lib/hooks/use-tournament-websocket";
import { TournamentLobby } from "@/components/tournament/tournament-lobby";
import { OverviewTab } from "@/components/tournament/overview-tab";
import { MyMatchesTab } from "@/components/tournament/my-matches-tab";
import { AllMatchesTab } from "@/components/tournament/all-matches-tab";
import { PlayersTab } from "@/components/tournament/players-tab";
import { StandingsTab } from "@/components/tournament/standings-tab";
import { deriveMyMatches } from "@/components/tournament/use-my-matches";
import type { TournamentDetail } from "@/components/tournament/types";

export default function TournamentDetailPage() {
  const params = useParams();
  const slug = typeof params.slug === "string" ? params.slug : "";
  const router = useRouter();
  const searchParams = useSearchParams();

  const [tournament, setTournament] = useState<TournamentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((s) => {
        if (s?.user?.id) setCurrentUserId(s.user.id);
      })
      .catch(() => {});
  }, []);

  const fetchTournament = useCallback(() => {
    if (!slug) return;
    setLoading(true);
    fetch(`/api/tournaments/${slug}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load tournament");
        return res.json();
      })
      .then((data: TournamentDetail) => {
        setTournament(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [slug]);

  useEffect(() => {
    fetchTournament();
  }, [fetchTournament]);

  useTournamentWebsocket(slug, {
    onParticipantJoined: () => fetchTournament(),
    onParticipantLeft: () => fetchTournament(),
    onStarted: () => fetchTournament(),
    onCancelled: () => fetchTournament(),
    onMatchUpdated: () => fetchTournament(),
  });

  if (loading) {
    return (
      <div>
        <div className="mx-auto max-w-4xl p-6">
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent-primary border-t-transparent" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !tournament) {
    return (
      <div>
        <div className="mx-auto max-w-4xl p-6">
          <div className="rounded-lg border border-accent-cta/20 bg-accent-cta/10 p-6 text-accent-cta">
            {error ?? "Tournament not found"}
          </div>
        </div>
      </div>
    );
  }

  function getFormatLabel(format: string): string {
    if (format === "round_robin") return "Round Robin";
    if (format === "single_elim") return "Single Elimination";
    return format;
  }

  function getStatusVariant(status: string): "default" | "danger" | "success" | "warning" {
    if (status === "active") return "success";
    if (status === "pending") return "warning";
    if (status === "cancelled") return "danger";
    return "default";
  }

  const formatLabel = getFormatLabel(tournament.format);
  const statusVariant = getStatusVariant(tournament.status);
  const isCreator = currentUserId === tournament.createdByUserId;

  const isActive = tournament.status === "active";
  const allowedTabs = isActive
    ? ["overview", "my", "all", "players", "standings"]
    : ["all", "players", "standings"];
  const defaultTab = isActive ? "overview" : "standings";
  const rawTab = searchParams.get("tab") ?? "";
  const activeTab = allowedTabs.includes(rawTab) ? rawTab : defaultTab;

  function handleTabChange(id: string) {
    router.replace(`/tournament/${slug}?tab=${id}`);
  }

  const myMatchCount = tournament ? deriveMyMatches(tournament).needsMeCount : 0;
  const tabs: TabDef[] = isActive
    ? [
        { id: "overview", label: "Overview" },
        { id: "my", label: "My Matches", badge: myMatchCount > 0 ? myMatchCount : undefined },
        { id: "all", label: "All Matches" },
        { id: "players", label: "Players" },
        { id: "standings", label: "Standings" },
      ]
    : [
        { id: "all", label: "All Matches" },
        { id: "players", label: "Players" },
        { id: "standings", label: "Standings" },
      ];

  function renderPanel() {
    if (activeTab === "overview")
      return (
        <OverviewTab
          tournament={tournament!}
          tournamentSlug={slug}
          isHost={isCreator}
          currentUserPlayerId={tournament!.currentUserPlayerId}
          onChanged={fetchTournament}
          onGoToStandings={() => handleTabChange("standings")}
        />
      );
    if (activeTab === "my")
      return (
        <MyMatchesTab
          tournament={tournament!}
          tournamentSlug={slug}
          onChanged={fetchTournament}
        />
      );
    if (activeTab === "all")
      return (
        <AllMatchesTab
          tournament={tournament!}
          tournamentSlug={slug}
          isHost={isCreator}
          onChanged={fetchTournament}
        />
      );
    if (activeTab === "players")
      return (
        <PlayersTab
          tournament={tournament!}
          tournamentSlug={slug}
          isCreator={isCreator}
          currentUserPlayerId={tournament!.currentUserPlayerId}
          onChanged={fetchTournament}
        />
      );
    if (activeTab === "standings") return <StandingsTab tournamentSlug={slug} />;
    return null;
  }

  const header = (
    <div className="mb-6">
      <Link
        href="/tournaments"
        className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-secondary"
      >
        <ChevronLeft className="h-4 w-4" />
        All Tournaments
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-text-primary sm:text-3xl">
            {tournament.name}
          </h1>
          <div className="mt-2 flex items-center gap-3">
            <Badge variant={statusVariant}>{tournament.status}</Badge>
            <span className="text-sm text-text-muted">{formatLabel}</span>
          </div>
        </div>
      </div>
    </div>
  );

  if (tournament.status === "pending") {
    return (
      <div>
        <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
          {header}
          <TournamentLobby
            tournament={tournament}
            tournamentSlug={slug}
            isCreator={isCreator}
            currentUserId={currentUserId}
            onChanged={fetchTournament}
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
        {header}
        <Tabs tabs={tabs} value={activeTab} onChange={handleTabChange} />
        {renderPanel()}
      </div>
    </div>
  );
}
