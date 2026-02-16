use anchor_lang::prelude::*;

declare_id!("SigAtt1111111111111111111111111111111111111");

/// Classification enum matching the TypeScript signal scorer output.
/// Stored as a single byte on-chain.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    Capital   = 0,
    Info      = 1,
    Velocity  = 2,
    Liquidity = 3,
    News      = 4,
    Time      = 5,
}

/// On-chain attestation account. One PDA per scored signal.
/// Seeds: ["attestation", authority, movement_id_hash]
#[account]
pub struct SignalAttestation {
    /// SHA-256 of the full signal JSON payload
    pub signal_hash: [u8; 32],
    /// SHA-256 of market_id (keeps PDA seeds fixed-length)
    pub market_id_hash: [u8; 32],
    /// Signal classification
    pub classification: u8,
    /// Confidence scaled to basis points (0.75 → 7500)
    pub confidence_bps: u16,
    /// Unix timestamp (seconds) when the signal was scored
    pub timestamp: i64,
    /// The authority (service wallet) that submitted this attestation
    pub authority: Pubkey,
    /// Bump seed for PDA derivation
    pub bump: u8,
}

/// Fixed size: 32 + 32 + 1 + 2 + 8 + 32 + 1 = 108 bytes + 8 discriminator = 116
const ATTESTATION_SIZE: usize = 8 + 32 + 32 + 1 + 2 + 8 + 32 + 1;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RecordSignalParams {
    pub signal_hash: [u8; 32],
    pub market_id_hash: [u8; 32],
    pub movement_id_hash: [u8; 32],
    pub classification: u8,
    pub confidence_bps: u16,
    pub timestamp: i64,
}

#[program]
pub mod signal_attestation {
    use super::*;

    pub fn record_signal(
        ctx: Context<RecordSignal>,
        params: RecordSignalParams,
    ) -> Result<()> {
        let attestation = &mut ctx.accounts.attestation;
        attestation.signal_hash = params.signal_hash;
        attestation.market_id_hash = params.market_id_hash;
        attestation.classification = params.classification;
        attestation.confidence_bps = params.confidence_bps;
        attestation.timestamp = params.timestamp;
        attestation.authority = ctx.accounts.authority.key();
        attestation.bump = ctx.bumps.attestation;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(params: RecordSignalParams)]
pub struct RecordSignal<'info> {
    #[account(
        init,
        payer = authority,
        space = ATTESTATION_SIZE,
        seeds = [
            b"attestation",
            authority.key().as_ref(),
            &params.movement_id_hash,
        ],
        bump,
    )]
    pub attestation: Account<'info, SignalAttestation>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
