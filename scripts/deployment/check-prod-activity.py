#!/usr/bin/env python3
"""Check production gameplay before a staging or production deploy. Read counts only."""
import argparse
from contextlib import closing
from pathlib import Path
import sqlite3
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("--force", choices=("true", "false"), default="false")
    parser.add_argument("--target", choices=("production", "staging"), default="production")
    args = parser.parse_args()
    if args.force == "true":
        print("Force set: skipping the gameplay activity guard. Engine preflight still applies.")
        return 0

    label = "Staging deploy skipped" if args.target == "staging" else "Production deploy refused"
    names = ["duels", "drafts"]
    query = """
        select
            (select count(*) from duels where status = 'active'
                or (status = 'lobby' and opening_json is not null)),
            (select count(*) from drafts where status = 'active')
    """
    if args.target == "production":
        names.extend(("tournament_rounds", "series"))
        query += """,
            (select count(*) from (
                select tm.tournament_id, tm.round_number
                from tournament_matches tm
                join tournaments t on t.id = tm.tournament_id
                where t.status = 'active' and tm.status in ('open', 'pending_approval')
                group by tm.tournament_id, tm.round_number
            )),
            (select count(*) from duel_series where status in ('active', 'between_games'))
        """

    try:
        # mode=ro sees committed WAL writes without opening the app or running migrations.
        # One SELECT gives all counts from the same SQLite snapshot.
        with closing(sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True, timeout=1)) as db:
            db.execute("pragma query_only=on")
            counts = db.execute(query).fetchone()
    except (OSError, sqlite3.Error) as error:
        print(f"{label}: cannot read gameplay activity ({error}).", file=sys.stderr)
        return 1

    print("Production activity: " + " ".join(
        f"{name}={count}" for name, count in zip(names, counts)
    ))
    if any(counts):
        if args.target == "staging":
            print(f"{label}: production is busy.", file=sys.stderr)
        else:
            print(f"{label}: gameplay is active. Wait for downtime, or explicitly set force.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
