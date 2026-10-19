build-programs:
	anchor build -p ext_swap -- --features migrate --no-default-features
	anchor build -p m_ext -- --features scaled-ui --no-default-features
	@mv target/deploy/m_ext.so target/deploy/scaled_ui.so
	@mv target/idl/m_ext.json target/idl/scaled_ui.json
	@mv target/types/m_ext.ts target/types/scaled_ui.ts
	anchor build -p m_ext -- --features no-yield,handoff --no-default-features
	@mv target/deploy/m_ext.so target/deploy/no_yield.so
	@mv target/idl/m_ext.json target/idl/no_yield.json
	@mv target/types/m_ext.ts target/types/no_yield.ts
	anchor build -p m_ext -- --features crank --no-default-features
	@mv target/deploy/m_ext.so target/deploy/crank.so
	@mv target/idl/m_ext.json target/idl/crank.json
	@mv target/types/m_ext.ts target/types/crank.ts
	anchor build -p m_ext -- --features no-yield,migrate --no-default-features
	@mv target/idl/m_ext.json target/idl/migrate.json
	@mv target/types/m_ext.ts target/types/migrate.ts

test-programs:
	@pnpm jest --preset ts-jest --verbose tests/unit/**.test.ts; exit $$?
	@cargo test; exit $$?

define update-program-id
 	@echo "Updating program ID in m_ext/src/lib.rs to $(1)"
	@sed -i '' 's/declare_id!("[^"]*")/declare_id!("$(1)")/' programs/m_ext/src/lib.rs
endef

build-test-programs:
	$(call update-program-id,3joDhmLtHLrSBGfeAe1xQiv3gjikes3x8S4N3o6Ld8zB)
	anchor build -p m_ext
	@mv target/deploy/m_ext.so tests/programs/ext_a.so
	$(call update-program-id,HSMnbWEkB7sEQAGSzBPeACNUCXC9FgNeeESLnHtKfoy3)
	anchor build -p m_ext -- --features scaled-ui --no-default-features
	@mv target/deploy/m_ext.so tests/programs/ext_b.so
	$(call update-program-id,81gYpXqg8ZT9gdkFSe35eqiitqBWqVfYwDwVfXuk8Xfw)
	sed -i '' '/pub ext_token_program: Interface<'\''info, TokenInterface>,/a\'$$'\n''\ pub dummy_account: Interface<'\''info, TokenInterface>,' programs/m_ext/src/instructions/wrap.rs
	cargo fmt
	anchor build -p m_ext --skip-lint
	@mv target/deploy/m_ext.so tests/programs/ext_c.so
	sed -i '' '/pub dummy_account: Interface<'\''info, TokenInterface>,/d' programs/m_ext/src/instructions/wrap.rs
	$(call update-program-id,3C865D264L4NkAm78zfnDzQJJvXuU3fMjRUvRxyPi5da)
	anchor build -p m_ext
