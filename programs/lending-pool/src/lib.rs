use anchor_lang::prelude::*;
use anchor_lang::{prelude::*, solana_program::entrypoint::ProgramResult};

use anchor_spl::{
    token_2022_extensions,
    associated_token::AssociatedToken,
    token_2022::{
        self,
        spl_token_2022::{
            extension::{
                group_member_pointer::GroupMemberPointer, metadata_pointer::MetadataPointer,
                mint_close_authority::MintCloseAuthority, permanent_delegate::PermanentDelegate,
                transfer_hook::TransferHook, self,
            },
            instruction::TokenInstruction::MintTo,
        },
    },
    token_interface::{
        spl_token_metadata_interface::state::TokenMetadata, token_metadata_initialize, Mint,
        Token2022, TokenAccount, TokenMetadataInitialize,
    },
};

mod types;
use types::*;

declare_id!("Dc3diDtBztbtXgnLtHHn8MnPjjiGHBK5AfxQ5GHWGSXQ");

const DISCRIMINATOR: usize = 8;

#[program]
pub mod lending_pool {
    use anchor_spl::{token_2022::spl_token_2022::extension::interest_bearing_mint, token_interface::interest_bearing_mint_update_rate};

    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.pool.total_deposits = 0;
        ctx.accounts.pool.total_borrows = 0;
        Ok(())
    }

    pub fn register_depositor(_ctx: Context<Registration>) -> Result<()> {
        // Anchor account constraints conduct the actual registration.
        // Registration is the act of creating an ATA for the depositor if it doesn't exist.

        // TODO: Ensure depositor does not register twice.

        msg!(
            "Registering ATA Address: {}",
            _ctx.accounts.depositor_ata.key()
        );

        Ok(())
    }

    pub fn unregister_depositor(ctx: Context<Registration>) -> Result<()> {
        // Ensure the depositor's iSOL balance is zero
        let depositor_ata = &ctx.accounts.depositor_ata;
        require!(depositor_ata.amount == 0, LendingPoolError::NonZeroBalance);

        // Close the depositor's associated token account (ATA) for iSOL
        let cpi_accounts = anchor_spl::token::CloseAccount {
            account: depositor_ata.to_account_info(),
            destination: ctx.accounts.depositor.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        anchor_spl::token::close_account(cpi_ctx)?;

        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        msg!(
            "Depositor ATA Address: {}",
            ctx.accounts.depositor_ata.key()
        );

        // Transfer SOL from depositor to the pool PDA
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.depositor.key(),
            &ctx.accounts.pool_pda.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.depositor.to_account_info(),
                ctx.accounts.pool_pda.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // Mint iSOL tokens to the depositor's associated token account
        let cpi_accounts = token_2022::MintTo {
            mint: ctx.accounts.isol_mint.to_account_info(),
            to: ctx.accounts.depositor_ata.to_account_info(),
            authority: ctx.accounts.isol_mint_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        

        let isol_mint_auth_seeds:&[&[&[u8]]] = &[&[b"isol_mint_auth", &[ctx.bumps.isol_mint_authority]]];
        
        let cpi_ctx = CpiContext::new_with_signer(
            cpi_program, 
            cpi_accounts,
            &isol_mint_auth_seeds,
        );
        token_2022::mint_to(cpi_ctx, amount)?;

        // Update total deposits
        ctx.accounts.pool_pda.total_deposits = ctx.accounts.pool_pda.total_deposits.checked_add(amount)
            .ok_or(LendingPoolError::MathOverflow)?;

        Ok(())
    }

    pub fn borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
        msg!("Borrower ATA Address: {}", ctx.accounts.borrower_ata.key());

        // Ensure the pool has enough available SOL to borrow
        let available_borrows = calculate_available_borrows(&ctx.accounts.pool_pda);
        require!(available_borrows >= amount, LendingPoolError::NotEnoughAvailableBorrows);

        // Determine the required collateral
        let required_collateral = calculate_required_collateral(amount)?;

        // Ensure the borrower has enough collateral in their ATA
        require!(
            ctx.accounts.borrower_ata.amount >= required_collateral,
            LendingPoolError::InsufficientCollateral
        );

        // Transfer tokens from borrower to the collateral PDA
        let cpi_accounts = token_2022::Transfer {
            from: ctx.accounts.borrower_ata.to_account_info(),
            to: ctx.accounts.collateral_pool_pda.to_account_info(),
            authority: ctx.accounts.borrower.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token_2022::transfer(cpi_ctx, required_collateral)?;

        // Transfer SOL from pool PDA to the borrower
        **ctx
            .accounts
            .pool_pda
            .to_account_info()
            .try_borrow_mut_lamports()? -= amount;

        **ctx
            .accounts
            .borrower
            .to_account_info()
            .try_borrow_mut_lamports()? += amount;

        // Update total borrows
        ctx.accounts.pool_pda.total_borrows = ctx.accounts.pool_pda.total_borrows.checked_add(amount)
            .ok_or(LendingPoolError::MathOverflow)?;

        // Update interest rate
        let new_rate = compute_interest_rate(&ctx.accounts.pool_pda)?;
        let isol_mint_auth_seeds:&[&[&[u8]]] = &[&[b"isol_mint_auth", &[ctx.bumps.isol_mint_authority]]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(), 
            token_2022_extensions::InterestBearingMintUpdateRate {
                token_program_id: ctx.accounts.token_program.to_account_info(),
                mint: ctx.accounts.isol_mint.to_account_info(),
                rate_authority: ctx.accounts.isol_mint_authority.to_account_info(),
            },
            &isol_mint_auth_seeds,
        );
        interest_bearing_mint_update_rate(cpi_ctx, new_rate)?;

        // Update the loan record PDA
        let new_loan_amount = ctx.accounts.loan_record.amount.checked_add(amount)
            .ok_or(LendingPoolError::MathOverflow)?;

        // Get the current timestamp
        let current_time = Clock::get()?.unix_timestamp as u64;

        // Set expiration time to one year from now
        let expiration_time = current_time.checked_add(365 * 24 * 60 * 60) // 365 days in seconds
            .ok_or(LendingPoolError::MathOverflow)?;

        ctx.accounts.loan_record.amount = new_loan_amount;
        ctx.accounts.loan_record.expiration_time = expiration_time;

        Ok(())
    }
}

fn calculate_required_collateral(amount: u64) -> Result<u64> {
    // TODO: compute the interest rate + overcollateralization.
    // For now, we will just return a "developer discount" of 1.
    Ok(1)
}

fn calculate_available_borrows(pool: &PoolState) -> u64 {
    pool.total_deposits - pool.total_borrows
}


/// Computes the interest rate based on the pool utilization.
/// 
/// The interest rate is calculated using a simple linear model:
/// - At 0% utilization, the interest rate is set to a minimum (e.g., 0%)
/// - At 100% utilization, the interest rate is set to a maximum (e.g., 100%)
/// - Between 0% and 100%, the rate increases linearly
///
/// @param pool: The PoolState account containing total deposits and borrows (in lamports)
/// @return Result<i16>: The updated interest rate in basis points (100 basis points = 1%)
fn compute_interest_rate(pool: &PoolState) -> Result<i16> {
    const MIN_RATE: i16 = 0; // 0% (in basis points)
    const MAX_RATE: i16 = 10000; // 100% (in basis points)
    const RATE_RANGE: i16 = MAX_RATE - MIN_RATE;
    const BASIS_POINTS_DIVISOR: u128 = 10000; // 100% in basis points

    let total_deposits: u128 = pool.total_deposits.into();
    let total_borrows: u128 = pool.total_borrows.into();

    // Avoid division by zero
    if total_deposits == 0 {
        return Ok(MIN_RATE);
    }

    // Calculate utilization
    // Utilization is the ratio of total borrows to total deposits, expressed in basis points
    // Formula: utilization = (total_borrows * BASIS_POINTS_DIVISOR) / total_deposits
    // This calculation is done in lamports (1 SOL = 1e9 lamports) for precise percentile utilization
    // For example, if total_borrows is 75 SOL and total_deposits is 100 SOL,
    // utilization would be (75_000_000_000 * 10000) / 100_000_000_000 = 7500 basis points, or 75%
    let utilization = total_borrows
        .checked_mul(BASIS_POINTS_DIVISOR)   .ok_or(LendingPoolError::MathOverflow)?
        .checked_div(total_deposits)         .ok_or(LendingPoolError::MathOverflow)?;

    // Log the uncapped utilization rate as a percentage using integer math
    msg!("Uncapped utilization rate: {}%", utilization * 100 / BASIS_POINTS_DIVISOR);

    // Ensure utilization doesn't exceed BASIS_POINTS_DIVISOR (100%)
    let utilization = std::cmp::min(utilization, BASIS_POINTS_DIVISOR);

    // Calculate interest rate (in basis points)
    // The rate increases linearly from MIN_RATE to MAX_RATE as utilization goes from 0% to 100%
    let interest_rate = (RATE_RANGE as u128)
        .checked_mul(utilization)           .ok_or(LendingPoolError::MathOverflow)?
        .checked_div(BASIS_POINTS_DIVISOR)  .ok_or(LendingPoolError::MathOverflow)?
        .checked_add(MIN_RATE as u128)      .ok_or(LendingPoolError::MathOverflow)?;

    // Log the uncapped interest rate as a percentage using integer math
    msg!("Uncapped interest rate: {}%", interest_rate * 100 / BASIS_POINTS_DIVISOR);
    
    // Cap the interest rate at MAX_RATE and convert to i16
    Ok(std::cmp::min(interest_rate, MAX_RATE as u128) as i16)
}







#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = PoolState::len(),
        seeds = [b"pool"],
        bump
    )]
    pub pool: Account<'info, PoolState>,
    #[account(
        init,
        payer = payer,
        token::mint = collateral_mint,
        token::authority = collateral_pool_pda,
        mint::token_program = token_program,
        seeds = [b"collateral"],
        bump
    )]
    pub collateral_pool_pda: InterfaceAccount<'info, TokenAccount>,
    pub collateral_mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Borrow<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,

    #[account(
        init_if_needed, // HACK: I don't know why I can't just use mut.
        payer = borrower,
        associated_token::mint = collateral_mint,
        associated_token::authority = borrower,
        mint::token_program = token_program,
    )]
    pub borrower_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"pool"],
        bump
    )]
    /// CHECK: Well-known account.
    pub pool_pda: Account<'info, PoolState>,

    #[account(
        mut,
        seeds = [b"collateral"],
        bump
    )]
    pub collateral_pool_pda: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub isol_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"isol_mint_auth"],
        bump
    )]
    /// CHECK: Well-known account.
    pub isol_mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    #[account(
        init_if_needed,
        payer = borrower,
        space = LoanRecord::len(),
        seeds = [b"loan", borrower.key().as_ref()],
        bump
    )]
    pub loan_record: Account<'info, LoanRecord>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        init_if_needed, // HACK: I don't know why I can't just use mut.
        payer = depositor,
        associated_token::mint = isol_mint,
        associated_token::authority = depositor,
        mint::token_program = token_program,
    )]
    pub depositor_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub isol_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"isol_mint_auth"],
        bump
    )]
    /// CHECK: Well-known account.
    pub isol_mint_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"pool"],
        bump
    )]
    /// CHECK: Well-known account.
    pub pool_pda: Account<'info, PoolState>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct Registration<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(
        init_if_needed, // Not safe.
        payer = depositor,
        associated_token::mint = mint,
        associated_token::authority = depositor,
        mint::token_program = token_program,
    )]
    pub depositor_ata: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[account]
pub struct PoolState {
    pub total_deposits: u64,
    pub total_borrows: u64,
}
impl PoolState {
    pub fn len() -> usize {
        DISCRIMINATOR +
        U64 + U64
    }
}

#[account]
pub struct LoanRecord {
    pub amount: u64,
    pub expiration_time: u64,
}

impl LoanRecord {
    pub fn len() -> usize {
        DISCRIMINATOR + // Discriminator
        U64 + // amount
        U64  // expiration_time
    }
}

#[error_code]
pub enum LendingPoolError {
    #[msg("Invalid pool PDA")]
    InvalidPoolPDA,

    #[msg("Depositor has a non-zero iSOL balance")]
    NonZeroBalance,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Not enough available SOL to borrow")]
    NotEnoughAvailableBorrows,

    #[msg("Insufficient collateral")]
    InsufficientCollateral,

    #[msg("Loan record already exists")]
    LoanRecordAlreadyExists,
}