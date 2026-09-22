import pytest

from backend import main, prometheus_link as link


def nodes(*names):
    return {n: {"url": f"http://{n}:8123"} for n in names}


# ---- suggesting the job you meant ----------------------------------------


def test_case_is_the_mistake_people_actually_make():
    assert link.suggest("bigboy", ["Bigboy", "nuc"]) == "Bigboy"


def test_a_trailing_domain_matches_either_way():
    assert link.suggest("nuc", ["nuc.local"]) == "nuc.local"
    assert link.suggest("nuc.local", ["nuc"]) == "nuc"


def test_a_typo_is_caught_by_fuzzy_matching():
    assert link.suggest("bigboy", ["bigbov"]) == "bigbov"


def test_an_unrelated_name_suggests_nothing():
    """Better to say 'add a job' than to point at the wrong host."""
    assert link.suggest("bigboy", ["totally-different", "other"]) is None


def test_nothing_to_suggest_when_prometheus_has_no_jobs():
    assert link.suggest("bigboy", []) is None


# ---- the scrape config ----------------------------------------------------


def test_the_exporter_address_comes_from_the_agents_own_url():
    """The agent is on 8123 at an address that already works; node_exporter
    is on 9100 at the same one."""
    assert link.exporter_address("http://100.72.159.83:8123") == "100.72.159.83:9100"


def test_a_hostname_url_works_too():
    assert link.exporter_address("http://bigboy:8123") == "bigboy:9100"


def test_a_missing_or_unparseable_url_is_not_fatal():
    assert link.exporter_address(None) is None
    assert link.exporter_address("not a url") is None


def test_the_scrape_config_names_the_job_after_the_host():
    config = link.scrape_config("bigboy", "http://100.72.159.83:8123")

    assert "job_name: bigboy" in config
    assert "'100.72.159.83:9100'" in config


def test_the_scrape_config_falls_back_to_the_host_name():
    assert "'bigboy:9100'" in link.scrape_config("bigboy", None)


# ---- what gets reported ---------------------------------------------------


def test_a_matched_agent_produces_nothing():
    issues, steps = link.issues(nodes("bigboy"), ["bigboy"])
    assert issues == [] and steps == []


def test_an_unmatched_agent_is_reported_with_the_likely_fix():
    issues, steps = link.issues(nodes("bigboy"), ["Bigboy"])

    (issue,) = issues
    assert issue["key"] == "host:bigboy:no-metrics"
    assert issue["severity"] == "warn"
    assert "Bigboy" in issue["message"]
    assert "HOST_NAME=Bigboy" in steps[0]


def test_an_unmatched_agent_with_no_near_miss_gets_a_scrape_config():
    issues, steps = link.issues(nodes("newbox"), ["bigboy", "thinkpad"])

    assert "no job called newbox" in issues[0]["message"].replace("  ", " ")
    assert "job_name: newbox" in steps[0]


def test_nothing_is_reported_when_prometheus_is_unreachable():
    """jobs is empty then. Calling every host misconfigured would bury the
    one thing that's actually wrong."""
    assert link.issues(nodes("bigboy", "thinkpad"), []) == ([], [])


def test_a_prometheus_job_with_no_agent_is_not_an_issue():
    """Monitoring a host without running an agent there is a legitimate
    setup, not a mistake."""
    issues, _ = link.issues(nodes("bigboy"), ["bigboy", "router"])
    assert issues == []


def test_the_order_is_stable():
    issues, _ = link.issues(nodes("zeta", "alpha", "mid"), ["other"])
    assert [i["key"] for i in issues] == [
        "host:alpha:no-metrics", "host:mid:no-metrics", "host:zeta:no-metrics",
    ]


# ---- through the overview -------------------------------------------------


def test_the_overview_carries_the_mismatch():
    out = main._overview(
        {}, [], set(), {}, [],
        nodes=nodes("bigboy"),
        prometheus_jobs=["Bigboy"],
    )

    assert out["ok"] is False
    assert any(i["key"] == "host:bigboy:no-metrics" for i in out["issues"])
    assert any("HOST_NAME=Bigboy" in r for r in out["recommendations"])


def test_the_overview_is_clean_when_the_names_line_up():
    out = main._overview(
        {}, [], set(), {}, [],
        nodes=nodes("bigboy"),
        prometheus_jobs=["bigboy"],
    )

    assert out["ok"] is True


def test_the_overview_still_works_without_the_new_arguments():
    """The /ws loop passes them; nothing else has to."""
    assert main._overview({}, [], set())["ok"] is True
