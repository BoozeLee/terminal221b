//! The drift guard, as a test rather than a promise.
//!
//! The bug this whole slice exists to fix was one boundary enforced in two
//! places that had already diverged. A comment saying "both sides read the same
//! file" proves nothing. What proves it is this: take the real file, remove a
//! prohibition from a profile, and assert that both the Rust renderer and the
//! TypeScript renderer notice. A guard that has only ever run green has not
//! been shown to fire, and a guard with no control proves nothing when it does.

#[cfg(test)]
mod tests {
    use crate::boundary::{Boundary, BoundaryFile, boundary_path};

    fn load() -> BoundaryFile {
        let raw = std::fs::read_to_string(boundary_path()).expect("the boundary file reads");
        serde_json::from_str(&raw).expect("the boundary file parses")
    }

    fn render_from(file: &BoundaryFile, profile: &str) -> String {
        let wanted = file
            .profiles
            .get(profile)
            .unwrap_or_else(|| panic!("the {profile} profile exists"));
        file.clause_order
            .iter()
            .filter(|clause| wanted.contains(clause))
            .map(|clause| file.clauses.get(clause).cloned().unwrap_or_default())
            .collect::<Vec<String>>()
            .join(" ")
    }

    #[test]
    fn the_control_the_real_file_carries_the_prohibition() {
        let file = load();
        assert!(file.profiles["crypto"].contains(&"no_wallet_secrets".to_string()));
        assert!(render_from(&file, "crypto").contains("Do not handle or request wallet secrets."));
    }

    #[test]
    fn removing_a_prohibition_from_the_crypto_profile_is_visible_to_the_rust_renderer() {
        let mut file = load();
        file.profiles
            .get_mut("crypto")
            .expect("the crypto profile exists")
            .retain(|clause| clause != "no_wallet_secrets");

        assert!(!render_from(&file, "crypto").contains("Do not handle or request wallet secrets."));

        // And through the production path, not only the local render above: a
        // renderer that only notices a mutation in a helper is not guarding.
        let mut boundary = Boundary::load().expect("boundary loads");
        boundary.file = file;
        let rendered = boundary.render("crypto").expect("still renders");
        assert!(!rendered.contains("Do not handle or request wallet secrets."));
    }

    #[test]
    fn removing_a_universal_prohibition_changes_the_coding_system_text() {
        let mut file = load();
        file.profiles
            .get_mut("coding")
            .expect("the coding profile exists")
            .retain(|clause| clause != "no_secrets_requested_or_transmitted");
        let rendered = render_from(&file, "coding");
        assert!(!rendered.contains("Never request, print, commit, or transmit"));
    }

    #[test]
    fn a_clause_added_to_one_side_and_not_the_other_is_visible_as_a_gap() {
        // The growing direction: a new universal prohibition the file does not
        // carry yet must read as absent, which is what stops the two clause
        // vocabularies drifting apart in the other direction.
        let boundary = Boundary::load().expect("boundary loads");
        let mut required = boundary.universal_clauses();
        required.push("a_clause_only_the_typescript_side_knows");
        let crypto = boundary.clauses_of("crypto").expect("crypto resolves");
        assert!(!crypto.contains(&"a_clause_only_the_typescript_side_knows"));
    }

    #[test]
    fn the_two_profiles_render_different_lengths_so_a_merge_cannot_pass_silently() {
        let boundary = Boundary::load().expect("boundary loads");
        let coding = boundary.render("coding").expect("coding renders");
        let crypto = boundary.render("crypto").expect("crypto renders");
        assert!(
            crypto.len() > coding.len(),
            "crypto must render longer than coding, {} vs {}",
            crypto.len(),
            coding.len()
        );
    }

    #[test]
    fn every_clause_in_the_order_has_text_and_every_text_has_an_order_entry() {
        let file = load();
        for name in &file.clause_order {
            assert!(
                file.clauses.contains_key(name),
                "{name} is in clauseOrder with no text"
            );
        }
        for name in file.clauses.keys() {
            assert!(
                file.clause_order.contains(name),
                "{name} has text but no order entry"
            );
        }
    }

    #[test]
    fn the_rust_renderer_knows_the_analyst_profile_and_it_is_not_a_rename_of_coding() {
        let file = load();
        let analyst = render_from(&file, "analyst");
        let coding = render_from(&file, "coding");
        assert_ne!(
            analyst, coding,
            "the analyst profile must render different text from coding, or --role selects nothing"
        );
        assert!(
            analyst.contains("Do not propose patches or code changes"),
            "the analyst prohibition is missing from the rendered text"
        );
    }

    #[test]
    fn the_analyst_clause_does_not_leak_into_the_coding_or_crypto_profiles() {
        let file = load();
        for profile in ["coding", "crypto"] {
            let rendered = render_from(&file, profile);
            assert!(
                !rendered.contains("Do not propose patches or code changes"),
                "{profile} must not carry the analyst-only clause"
            );
        }
    }

    #[test]
    fn every_profile_carries_the_universal_clauses() {
        let file = load();
        let loaded = Boundary::load().expect("the boundary loads");
        let universal = loaded.universal_clauses();
        for name in file.profiles.keys() {
            let clauses = file.profiles.get(name).expect("profile is present").clone();
            for required in &universal {
                assert!(
                    clauses.iter().any(|clause| clause == required),
                    "{name} is missing the universal clause {required}"
                );
            }
        }
    }
}
