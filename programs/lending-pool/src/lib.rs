use anchor_lang::prelude::*;
use anchor_lang::{prelude::*, solana_program::entrypoint::ProgramResult};

use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{
        self,
        spl_token_2022::{
            extension::{
                group_member_pointer::GroupMemberPointer, metadata_pointer::MetadataPointer,
                mint_close_authority::MintCloseAuthority, permanent_delegate::PermanentDelegate,
                transfer_hook::TransferHook,
            },
            instruction::TokenInstruction::MintTo,
        },
    },
    token_interface::{
        spl_token_metadata_interface::state::TokenMetadata, token_metadata_initialize, Mint,
        Token2022, TokenAccount, TokenMetadataInitialize,
    },
};

declare_id!("Dc3diDtBztbtXgnLtHHn8MnPjjiGHBK5AfxQ5GHWGSXQ");

#[program]
pub mod lending_pool {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        // Additional initialization logic if needed
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
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.depositor_ata.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token_2022::mint_to(cpi_ctx, amount)?;

        Ok(())
    }

    pub fn borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
        msg!("Borrower ATA Address: {}", ctx.accounts.borrower_ata.key());

        // Determine the required collateral
        let required_collateral = calculate_required_collateral(amount)?;

        // Transfer tokens from borrower to the collateral PDA
        let cpi_accounts = token_2022::Transfer {
            from: ctx.accounts.borrower_ata.to_account_info(),
            to: ctx.accounts.collateral_ta_pda.to_account_info(),
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

        Ok(())
    }
}

fn calculate_required_collateral(amount: u64) -> Result<u64> {
    // TODO: compute the interest rate + overcollateralization.
    // For now, we will just return the same amount as a placeholder
    Ok(amount)
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8, // Anchor Discriminator
        seeds = [b"pool"],
        bump
    )]
    /// CHECK: Doesn't do anything, just holds SOL.
    pub pool_pda: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        token::mint = collateral_mint,
        token::authority = collateral_ta_pda,
        mint::token_program = token_program,
        seeds = [b"collateral"],
        bump
    )]
    pub collateral_ta_pda: InterfaceAccount<'info, TokenAccount>,
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
        associated_token::mint = mint,
        associated_token::authority = borrower,
        mint::token_program = token_program,
    )]
    pub borrower_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"pool"],
        bump
    )]
    /// CHECK: Well-known account.
    pub pool_pda: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"collateral"],
        bump
    )]
    pub collateral_ta_pda: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        init_if_needed, // HACK: I don't know why I can't just use mut.
        payer = depositor,
        associated_token::mint = mint,
        associated_token::authority = depositor,
        mint::token_program = token_program,
    )]
    pub depositor_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: This is a read-only account
    pub mint_authority: AccountInfo<'info>, //TODO: Make a PDA be the authority.
    #[account(
        mut,
        seeds = [b"pool"],
        bump
    )]
    /// CHECK: Well-known account.
    pub pool_pda: AccountInfo<'info>,
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

#[error_code]
pub enum LendingPoolError {
    #[msg("Invalid pool PDA")]
    InvalidPoolPDA,

    #[msg("Depositor has a non-zero iSOL balance")]
    NonZeroBalance,
}
