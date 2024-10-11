
use anchor_lang::{
    prelude::*,
    system_program::{create_account, CreateAccount},
};
use raydium_amm_v3::{cpi::accounts::{DecreaseLiquidity, IncreaseLiquidity}, libraries::{get_delta_amounts_signed, get_liquidity_from_single_amount_0, get_sqrt_price_at_tick, Q64, U256}, program::AmmV3, states::{PersonalPositionState, PoolState, TickArrayState}};
use core as core_;
use raydium_amm_v3::states::LazyPersonalPositionState;
pub const TICK_ARRAY_SEED: &str = "tick_array";
pub const TICK_ARRAY_SIZE_USIZE: usize = 60;
pub const TICK_ARRAY_SIZE: i32 = 60;
use spl_token::solana_program::program_pack::Pack;
use anchor_spl::{
    associated_token::AssociatedToken, token::{self, Token}, token_2022::Token2022, token_interface::{self, Mint, TokenAccount}
};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, state::ExtraAccountMetaList, seeds::Seed
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};
use std::{ops::Mul, str::FromStr, u64};

// transfer-hook program that charges a SOL fee on token transfer
// use a delegate and wrapped SOL because signers from initial transfer are not accessible

declare_id!("AxaViNQ6EwvHuhAXXgsHkjAVXJdRTemYJeJEepaT8zDX");
use anchor_lang::prelude::Pubkey;

const SPAN: usize = std::mem::size_of::<PositionRef>();
use std::mem::size_of;

pub const POSITION_SEED: &str = "position";
#[inline(never)]
fn handle_existing_liquidity(
    ctx: &Context<TransferHook>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if ctx.accounts.protocol_position.to_account_info().owner != &Pubkey::from_str("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK").unwrap() {
        return Ok(())
    }

    // Load personal position data
    let personal_position = ctx.accounts.personal_position.load()?;
    let (liquidity, tick_lower, tick_upper, owed_0, owed_1) = (
        personal_position.liquidity,
        personal_position.tick_lower_index,
        personal_position.tick_upper_index,
        personal_position.token_fees_owed_0,
        personal_position.token_fees_owed_1
    );
    drop(personal_position);

    // Load pool state data
    let pool_state = ctx.accounts.pool_state.load()?;
    let (tick_current, sqrt_price_x64, token_mint_0, tick_spacing) = (
        pool_state.tick_current, pool_state.sqrt_price_x64, pool_state.token_mint_0, pool_state.tick_spacing
    );
    drop(pool_state);

    let in_range = tick_lower <= tick_current && tick_current <= tick_upper;

    if !in_range {
        if token_mint_0 == Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap() && ctx.accounts.token_account0.owner != ctx.accounts.extra_account_meta_list.key() { 
        let price_lower = get_sqrt_price_at_tick(tick_lower)?;
            let price_upper = get_sqrt_price_at_tick(tick_upper)?;
            let liq_calc = if token_mint_0 == Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap() {
                get_liquidity_from_single_amount_0(sqrt_price_x64, price_lower, price_upper, owed_0 / 2)
            } else {
                get_liquidity_from_single_amount_1(sqrt_price_x64, price_lower, price_upper, owed_1 / 2)
            };

            decrease_liquidity(ctx, signer_seeds, liq_calc)?;
        }
        else {
            decrease_liquidity(ctx, signer_seeds, liquidity)?;
        }
    } else {
        let inc_amt = liquidity / 2;
        let (amt_0, amt_1) = get_delta_amounts_signed(
           tick_current, sqrt_price_x64, tick_lower, tick_upper, inc_amt as i128,
        )?;
        increase_liquidity(ctx, inc_amt, amt_0 as u64, amt_1 as u64)?;
    }

    Ok(())
}#[inline(never)]
fn decrease_liquidity(
    ctx: &Context<TransferHook>,
    signer_seeds: &[&[&[u8]]],
    liquidity: u128,
) -> Result<()> {
    let extra_account_meta_list_seeds = [
        b"extra-account-metas".as_ref(),
        ctx.accounts.mint.to_account_info().key.as_ref(),
        &[ctx.bumps.extra_account_meta_list],
    ];

    let cpi_accounts = DecreaseLiquidity {
        nft_owner: ctx.accounts.extra_account_meta_list.to_account_info(),
        nft_account: ctx.accounts.nft_account.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        protocol_position: ctx.accounts.protocol_position.to_account_info(),
        personal_position: ctx.accounts.personal_position.to_account_info(),
        token_vault_0: ctx.accounts.token_vault0.to_account_info(),
        token_vault_1: ctx.accounts.token_vault1.to_account_info(),
        tick_array_lower: ctx.accounts.tick_array_lower.to_account_info(),
        tick_array_upper: ctx.accounts.tick_array_lower.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        recipient_token_account_0: ctx.accounts.token_account0.to_account_info(),
        recipient_token_account_1: ctx.accounts.token_account1.to_account_info(),
    };

    raydium_amm_v3::cpi::decrease_liquidity(
        CpiContext::new_with_signer(
            ctx.accounts.ray_or_eco.to_account_info(),
            cpi_accounts,
            &[&extra_account_meta_list_seeds]
        ),
        liquidity,
        0,
        0,
    )
}
use raydium_amm_v3::libraries::MulDiv;
#[inline(never)]
fn increase_liquidity(
    ctx: &Context<TransferHook>,
    liquidity: u128,
    amount_0: u64,
    amount_1: u64,
) -> Result<()> {
    let extra_account_meta_list_seeds = [
        b"extra-account-metas".as_ref(),
        ctx.accounts.mint.to_account_info().key.as_ref(),
        &[ctx.bumps.extra_account_meta_list],
    ];
    let owner = ctx.accounts.extra_account_meta_list.to_account_info();
    let seed: &[&[&[u8]]] = &[&extra_account_meta_list_seeds];

    let cpi_accounts = IncreaseLiquidity {
        nft_owner: owner,
        nft_account: ctx.accounts.nft_account.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        protocol_position: ctx.accounts.protocol_position.to_account_info(),
        personal_position: ctx.accounts.personal_position.to_account_info(),
        token_account_0: ctx.accounts.token_account0.to_account_info(),
        token_account_1: ctx.accounts.token_account1.to_account_info(),
        token_vault_0: ctx.accounts.token_vault0.to_account_info(),
        token_vault_1: ctx.accounts.token_vault1.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        tick_array_lower: ctx.accounts.tick_array_lower.to_account_info(),
        tick_array_upper: ctx.accounts.tick_array_lower.to_account_info(),
    };

    let cpi_program = ctx.accounts.ray_or_eco.to_account_info();
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, seed);

    raydium_amm_v3::cpi::increase_liquidity(cpi_ctx, liquidity, amount_0, amount_1)
}

pub fn get_tick_array_pubkeys(
    ticks: &[i32],
    tick_spacing: u16,
) -> Vec<i32> {
    let mut unique_start_indices = std::collections::HashSet::with_capacity(ticks.len());
    ticks.iter()
        .map(|&tick| TickArrayState::get_array_start_index(tick, tick_spacing))
        .filter(|&start_index| unique_start_indices.insert(start_index))
        .collect()
}

pub fn get_liquidity_from_amount_1(
    sqrt_ratio_a_x64: u128,
    sqrt_ratio_b_x64: u128,
    amount_1: u64,
) -> u128 {
    let (sqrt_ratio_a_x64, sqrt_ratio_b_x64) = if sqrt_ratio_a_x64 > sqrt_ratio_b_x64 {
        (sqrt_ratio_b_x64, sqrt_ratio_a_x64)
    } else {
        (sqrt_ratio_a_x64, sqrt_ratio_b_x64)
    };

    U256::from(amount_1)
        .mul_div_floor(
            U256::from(Q64),
            U256::from(sqrt_ratio_b_x64 - sqrt_ratio_a_x64),
        )
        .unwrap_or(U256::from(0))
        .try_into()
        .unwrap_or(0)
}

pub fn get_liquidity_from_single_amount_1(
    sqrt_ratio_x64: u128,
    sqrt_ratio_a_x64: u128,
    sqrt_ratio_b_x64: u128,
    amount_1: u64,
) -> u128 {
    let (sqrt_ratio_a_x64, sqrt_ratio_b_x64) = if sqrt_ratio_a_x64 > sqrt_ratio_b_x64 {
        (sqrt_ratio_b_x64, sqrt_ratio_a_x64)
    } else {
        (sqrt_ratio_a_x64, sqrt_ratio_b_x64)
    };

    if sqrt_ratio_x64 <= sqrt_ratio_a_x64 {
        0
    } else if sqrt_ratio_x64 < sqrt_ratio_b_x64 {
        get_liquidity_from_amount_1(sqrt_ratio_a_x64, sqrt_ratio_x64, amount_1)
    } else {
        get_liquidity_from_amount_1(sqrt_ratio_a_x64, sqrt_ratio_b_x64, amount_1)
    }
}
#[inline(never)]

fn update_game_totals(
    game_data: &mut [u8],
    liquidity_amount: u128,
    input_amount_a: u64,
    input_amount_b: u64,
) -> Result<()> {
    let total_liquidity_offset = 8 + 32;
    let total_deposited_a_offset = total_liquidity_offset + 8;
    let total_deposited_b_offset = total_deposited_a_offset + 8;

    let new_total_liquidity = u64::from_le_bytes(
        game_data[total_liquidity_offset..total_liquidity_offset + 8]
            .try_into()
            .unwrap(),
    )
    .checked_add(liquidity_amount.try_into().unwrap())
    .ok_or(ProgramError::AccountAlreadyInitialized)?;
    game_data[total_liquidity_offset..total_liquidity_offset + 8]
        .copy_from_slice(&new_total_liquidity.to_le_bytes());

    let new_total_deposited_a = u64::from_le_bytes(
        game_data[total_deposited_a_offset..total_deposited_a_offset + 8]
            .try_into()
            .unwrap(),
    )
    .checked_add(input_amount_a)
    .ok_or(ProgramError::AccountAlreadyInitialized)?;
    game_data[total_deposited_a_offset..total_deposited_a_offset + 8]
        .copy_from_slice(&new_total_deposited_a.to_le_bytes());

    let new_total_deposited_b = u64::from_le_bytes(
        game_data[total_deposited_b_offset..total_deposited_b_offset + 8]
            .try_into()
            .unwrap(),
    )
    .checked_add(input_amount_b)
    .ok_or(ProgramError::AccountAlreadyInitialized)?;
    game_data[total_deposited_b_offset..total_deposited_b_offset + 8]
        .copy_from_slice(&new_total_deposited_b.to_le_bytes());

    Ok(())
}

#[program]
pub mod transfer_hook {
    use std::u64;

    use anchor_lang::solana_program::{
        program::{invoke},
        system_instruction,
    };
    
    use anchor_spl::{
        associated_token::get_associated_token_address,
        token_2022::{self, set_authority, MintTo, SetAuthority}, 
    };
    use raydium_amm_v3::{libraries::U256, states::TickArrayState};
    use spl_token::solana_program::instruction::Instruction;

    use super::*;

    pub fn initialize_second_extra_account_meta_list(
        ctx: Context<InitializeSecondExtraAccountMetaList>,
    ) -> Result<()> {
        //////msg!("Initializing second extra account meta list");
        let account_metas = [
            ExtraAccountMeta::new_with_pubkey(
                &ctx.accounts.solana_safer_mewn_extra_account_meta_list.key(),
                false,
                true,
            )?,
            ExtraAccountMeta::new_with_pubkey(&Pubkey::from_str("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK").unwrap(), false, false)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.nft_account.key(), false, false)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.game.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.pool_state.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_program.key(), false, false)?, // 10
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.game.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.personal_position.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.protocol_position.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.nft_account.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_account0.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_account1.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_vault0.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_vault1.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.tick_array_lower.key(), false, true)?,
            ExtraAccountMeta::new_with_seeds(
                &[            Seed::Literal { bytes: ctx.accounts.pool_state.load()?.tick_current.to_be_bytes().to_vec() } 

                ], false, true)?,
        ];
        //////msg!("Account metas created");

        let account_size = ExtraAccountMetaList::size_of(account_metas.len())? as u64;
        let lamports = Rent::get()?.minimum_balance(account_size as usize);
        //////msg!("Account size: {}, Lamports: {}", account_size, lamports);

        let mint = ctx.accounts.mint.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"extra-account-metas",
            &mint.as_ref(),
            &[ctx.bumps.extra_account_meta_list],
        ]];
        //////msg!("Signer seeds created");

        create_account(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.funder.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
            )
            .with_signer(signer_seeds),
            lamports,
            account_size,
            ctx.program_id,
        )?;
        //////msg!("Account created");

        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        )?;
        //////msg!("Extra account meta list initialized");
        let game_acc = &mut ctx.accounts.game;
        game_acc.mint = ctx.accounts.mint.key();
        game_acc.other_mint = ctx.accounts.solana_safer_mewn.key();
        //////msg!("Game other mint updated");

        //////msg!("Second extra account meta list initialization completed");
        Ok(())
    }
/*
    pub fn initialize_first_extra_account_meta_list(
        ctx: Context<InitializeFirstExtraAccountMetaList>,
    ) -> Result<()> {
        ////msg!("Starting initialize_first_extra_account_meta_list");
        let account_metas = [
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.extra_account_meta_list.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.game.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.nft_account.key(), false, false)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.pool_state.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_program.key(), false, false)?, // 10
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.game.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.game.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.game.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.game.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.game.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.game.key(), false, true)?,
            ExtraAccountMeta::new_external_pda_with_seeds(
                6,
                &[
                    Seed::Literal { bytes: TICK_ARRAY_SEED.as_bytes().to_vec() } ,
                    Seed::AccountKey { index: 8} ,
                    Seed::Literal { bytes: ctx.accounts.position.tick_lower_index.to_be_bytes().to_vec() }
                ],
                false,
                true
            )?,
            ExtraAccountMeta::new_with_seeds(
                &[            Seed::Literal {  bytes: ctx.accounts.pool_state.tick_current.to_be_bytes().to_vec() } 

                ], false, true)?
    
        ];
        ////msg!("Account metas created");

        let account_size = ExtraAccountMetaList::size_of(account_metas.len())? as u64;
        let lamports = Rent::get()?.minimum_balance(account_size as usize);
        ////msg!("Account size: {}, Lamports: {}", account_size, lamports);

        let mint = ctx.accounts.mint.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"extra-account-metas",
            &mint.as_ref(),
            &[ctx.bumps.extra_account_meta_list],
        ]];
        ////msg!("Signer seeds created");

        create_account(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
            )
            .with_signer(signer_seeds),
            lamports,
            account_size,
            ctx.program_id,
        )?;
        ////msg!("Account created");

        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        )?;
        ////msg!("Extra account meta list initialized");
        let game_acc = &mut ctx.accounts.game.load_mut()?;
        game_acc.mint = ctx.accounts.mint.key();
        ////msg!("Game account mint updated");

        ////msg!("initialize_first_extra_account_meta_list completed successfully");
        Ok(())
    } */
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        ////msg!("Starting transfer_hook function");
        ////msg!("Current tick index: {}", tick_current)
        if ctx.accounts.ray_or_eco.key() != raydium_amm_v3::ID {
            // Optimized version for non-Raydium case
            let account_metas: [ExtraAccountMeta; 10] = [
                ExtraAccountMeta::new_with_pubkey(&ctx.accounts.extra_account_meta_list.key(), false, true)?,
                ExtraAccountMeta::new_with_pubkey(&Pubkey::from_str("EbKo6tpm9H79CLs3hoaQ6EhaSTCbWGqZdwPGvrD1qKUM").unwrap(), false, true)?,
                ExtraAccountMeta::new_with_pubkey(&ctx.accounts.nft_account.key(), false, false)?,
                ExtraAccountMeta::new_with_pubkey(&ctx.accounts.pool_state.key(), false, true)?,
                ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_program.key(), false, false)?,
                ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_account0.key(), false, true)?,
                ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_account1.key(), false, true)?,
                ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_vault0.key(), false, true)?,
                ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_vault1.key(), false, true)?,
                ExtraAccountMeta::new_with_pubkey(&crate::ID, false, false)?,
            ];
    
            let data_size = 8 + account_metas.len() * 33;
            let mut data = Vec::with_capacity(data_size);
            data.extend_from_slice(&(account_metas.len() as u64).to_le_bytes());
            for meta in account_metas.iter() {
                data.extend_from_slice(&meta.address_config);
            }
    
            let ix = Instruction {
                program_id: ctx.accounts.ray_or_eco.key(),
                accounts: ([
                    AccountMeta::new(ctx.accounts.safe.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.pool_state.key(), false)
                ]).to_vec(),
                data: data,
            };
    
            let account_infos = &[
                ctx.accounts.safe.to_account_info(),
                ctx.accounts.pool_state.to_account_info(),
                ctx.accounts.ray_or_eco.to_account_info()
            ];
    
            invoke(&ix, account_infos)?;
            ////msg!("transfer_hook function completed successfully");
        } else {
            ////msg!("NFT account owner: {}", nft_account_owner);
    
            let signer_seeds: &[&[&[u8]]] = &[&[
                b"extra-account-metas",
                ctx.accounts.mint.to_account_info().key.as_ref(),
                &[ctx.bumps.extra_account_meta_list],
            ]];
    
            handle_existing_liquidity(&ctx, signer_seeds)?;
        }
        Ok(())
    }
    pub fn process_game_data(ctx: Context<TransferHook2>,
        position_ref_2: u64,
        position_ref_1: i32,
        position_ref_0: i32,
        ref_0: i32,
        ref_1: i32,
        tick_spacing: u16,
        current_tick: i32,
        account_metas_address_configs: Vec<[u8; 32]>,
    ) -> Result<()> {
        // Recreate account_metas from address_configs

        let mut account_metas = Vec::with_capacity(account_metas_address_configs.len());
        for (index, address_config) in account_metas_address_configs.clone().iter().enumerate() {
            if index == 5 {
                account_metas.push(ExtraAccountMeta::new_external_pda_with_seeds(
                    6,
                    &[
                        Seed::Literal { bytes: POSITION_SEED.as_bytes().to_vec() },
                        Seed::AccountKey { index: 8},
                        Seed::Literal { bytes: ref_0.to_be_bytes().to_vec() },
                        Seed::Literal { bytes:  ref_1.to_be_bytes().to_vec() },
                    ],
                    false,
                    true
                )?);
                 
            }else if index == 13 {
                account_metas.push(ExtraAccountMeta::new_with_seeds(
                    &[            Seed::Literal {  bytes:  TickArrayState::get_array_start_index(ref_0, tick_spacing).to_be_bytes().to_vec() } 

                    ],
                    false,
                    true
                )?);
            } else if index == 11 {
                account_metas.push(ExtraAccountMeta::new_external_pda_with_seeds(
                    6,
                    &[
                        Seed::Literal { bytes: TICK_ARRAY_SEED.as_bytes().to_vec() },
                        Seed::AccountKey { index: 8 },
                        Seed::Literal {bytes: ref_0.to_be_bytes().to_vec()},
                    ],
                    false,
                    true,
                )?);
            }else {
            let pubkey = Pubkey::new_from_array(*address_config);
            let is_signer = false;
            let is_writable = match index {
                0 | 3 | 5 | 6 | 7 | 8 | 9 | 10 | 11 => true,
                _ => false,
            };
            account_metas.push(ExtraAccountMeta::new_with_pubkey(&pubkey, is_signer, is_writable)?);
        }
        }
    
        ExtraAccountMetaList::update::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        )?;
        Ok(())
    }
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)?;
 
        // match instruction discriminator to transfer hook interface execute instruction
        // token2022 program CPIs this instruction on token transfer
        match instruction {
            TransferHookInstruction::Execute { amount } => {
                let mut amount_bytes = amount.to_le_bytes().to_vec();
        
                // invoke custom transfer hook instruction on our program
                __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
            }
            _ => return Err(ProgramError::InvalidInstructionData.into()),
        }
    }
    
    pub fn open_position(
        ctx: Context<ProxyOpenPosition>
    ) -> Result<()> {
        msg!("Starting open_position function");
        let position = &ctx.accounts.personal_position;
        msg!("Deserialized PersonalPositionState");

        let tick_lower_index = position.tick_lower_index;
        let tick_upper_index = position.tick_upper_index;
        msg!("Tick indices: lower={}, upper={}", tick_lower_index, tick_upper_index);

        {
            let mut position_info = ctx.accounts.position_info.load_init()?;
            position_info.tick_lower_index = tick_lower_index;
            position_info.tick_upper_index = tick_upper_index;
            position_info.i = ctx.accounts.pool_state.load()?.tick_current;
            position_info.position_key = ctx.accounts.personal_position.key();
            position_info.nft_account = ctx.accounts.extra_nft_token_account.key();
            position_info.winner_ata = ctx.accounts.funder.key();
            position_info.pool_state = ctx.accounts.pool_state.key();
            msg!("Initialized position_info account");

            let position_ref = PositionRef {
                tick_lower_index,
                tick_upper_index,
                i:ctx.accounts.pool_state.load()?.tick_current,
                buff: [0; 4]
            };
            msg!("Created PositionRef");

            // Serialize PositionRef into game_data
            let position_ref_bytes = position_ref.try_to_vec()?;
            let game_ai = ctx.accounts.game.to_account_info();
            let mut game = game_ai.try_borrow_mut_data()?;
            let start_index = game.len() - position_ref_bytes.len();
            game[start_index..].copy_from_slice(&position_ref_bytes);
            msg!("Serialized PositionRef into game_data");
        }
        {

            let liquidity = position.liquidity;
            msg!("Position liquidity: {}", liquidity);

            // Transfer NFT from user's token account to game's NFT token account
            let transfer_nft_accounts = anchor_spl::token::Transfer {
                from: ctx.accounts.position_nft_account.to_account_info(),
                to: ctx.accounts.extra_nft_token_account.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                transfer_nft_accounts,
            );
            anchor_spl::token::transfer(cpi_ctx, 1)?;
            msg!("Transferred NFT to game's token account");

            let amount_to_mint = if ctx.accounts.pool_state.load()?.token_mint_0
                == Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap()
            {
                let amount = (liquidity as u128)
                    .checked_mul(ctx.accounts.pool_state.load()?.sqrt_price_x64)
                    .and_then(|result| result.checked_shr(64))
                    .and_then(|result| u64::try_from(result).ok())
                    .unwrap_or(0);
                msg!("Calculated amount_to_mint for token_mint0: {}", amount);
                amount
            } else {
                let inverse_price_x64 = (U256::from(1_u128) << 128)
                    .checked_div(U256::from(ctx.accounts.pool_state.load()?.sqrt_price_x64))
                    .unwrap_or(U256::from(0));
                let amount = U256::from(liquidity as u128)
                    .checked_mul(inverse_price_x64)
                    .and_then(|result| Some(result >> 64))
                    .and_then(|result| u64::try_from(result).ok())
                    .unwrap_or(0_u64);
                msg!("Calculated amount_to_mint for token_mint1: {}", amount);
                amount
            };

            let signer_seeds: &[&[&[u8]]] = &[&[
                b"gg",
                ctx.accounts.pool_state.to_account_info().key.as_ref(),
                &[ctx.bumps.game],
            ]];
            if ctx.accounts.mint_2.mint_authority.unwrap() != ctx.accounts.mint_authority.key() {
                let sa = SetAuthority {
                    current_authority: ctx.accounts.game.to_account_info(),
                    account_or_mint: ctx.accounts.mint_2.to_account_info(),
                };
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program_2022.to_account_info(),
                    sa,
                    signer_seeds,
                );
                set_authority(
                    cpi_ctx,
                    anchor_spl::token_2022::spl_token_2022::instruction::AuthorityType::MintTokens,
                    Some(ctx.accounts.mint_authority.key()),
                )?;
                msg!("Set mint authority");
            }

            let signer_seeds: &[&[&[u8]]] = &[&[b"mint-authority", &[ctx.bumps.mint_authority]]];
            let mint_to_accounts = MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.user_ata.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program_2022.to_account_info(),
                mint_to_accounts,
                signer_seeds,
            );
            token_2022::mint_to(cpi_ctx, amount_to_mint)?;
            msg!("Minted {} tokens to user_ata", amount_to_mint);

            let mint_to_accounts = MintTo {
                mint: ctx.accounts.mint_2.to_account_info(),
                to: ctx.accounts.user_ata_2.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program_2022.to_account_info(),
                mint_to_accounts,
                signer_seeds,
            );
            token_2022::mint_to(cpi_ctx, amount_to_mint)?;
            msg!("Minted {} tokens to user_ata_2", amount_to_mint);

            {
                let ai = ctx.accounts.game.to_account_info();
                let mut game_data = ai.try_borrow_mut_data()?;
                update_game_totals(&mut game_data, liquidity, 0, 0)?;
                
                msg!("Updated game totals");
                drop(game_data);
            }
        }
        {
            ctx.accounts.game.mint = Pubkey::from_str("DZVfZHdtS266p4qpTR7vFXxXbrBku18nt9Uxp4KD9bsi").unwrap();
        }

        msg!("open_position function completed successfully");
        Ok(())
    }

}
#[derive(Accounts)]
pub struct InitializeSecondExtraAccountMetaList<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        mut,
        seeds = [b"extra-account-metas", mint.key().as_ref()], 
        bump
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"extra-account-metas", solana_safer_mewn.key().as_ref()], 
        bump
    )]
    pub solana_safer_mewn_extra_account_meta_list: AccountInfo<'info>,

    #[account(
        init,
        payer = funder,
        mint::decimals = 9,
        mint::authority = mint_authority,
       // extensions::transfer_hook::program_id = crate::id(),
       // extensions::transfer_hook::authority = extra_account_meta_list,
       // extensions::metadata_pointer::authority = funder,
       // extensions::metadata_pointer::metadata_address = mint,
        mint::token_program = token_program_2022,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program_2022: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub solana_safer_mewn: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        seeds = [b"mint-authority"],
        bump
    )]
    pub mint_authority: SystemAccount<'info>,
    #[account(mut,
        seeds = [b"gg", pool_state.to_account_info().key.as_ref()],  
        bump)]
    pub game: Box<Account<'info, Game>>,
    pub raydium_amm_v3_program: AccountInfo<'info>,

    #[account(mut)]
    pub nft_account: AccountInfo<'info>,
    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    #[account(mut)]
    pub protocol_position: AccountInfo<'info>,
    #[account(mut)]
    pub personal_position: AccountInfo<'info>,
    #[account(mut)]
    pub token_account0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub token_account1: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub token_vault0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub token_vault1: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub tick_array_lower: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub position_info: AccountInfo<'info>
}

// Order of accounts matters for this struct.
// The first 4 accounts are the accounts required for token transfer (source, mint, destination, owner)
// Remaining accounts are the extra accounts required from the ExtraAccountMetaList account
// These accounts are provided via CPI to this program from the token2022 program
#[derive(Accounts)]
pub struct TransferHook2<'info> {

    #[account(mut)]
    pub extra_account_meta_list: AccountInfo<'info>,
}
use std::cell::Ref;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct TransferHook<'info> {
    pub source_token: AccountInfo<'info>,
    pub mint: AccountInfo<'info>,
    pub destination_token: AccountInfo<'info>,
    pub owner: AccountInfo<'info>,
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: AccountInfo<'info>,
    #[account(mut)]
    pub safe: AccountInfo<'info>,
    pub ray_or_eco: AccountInfo<'info>,
    pub nft_account: AccountInfo<'info>,
    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,
    pub token_program: AccountInfo<'info>,
    #[account(mut)]
    pub protocol_position: AccountInfo<'info>,
    #[account(mut)]
    pub personal_position: LazyAccount<'info, PersonalPositionState>,
    #[account(mut)]
    pub token_account0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub token_account1: AccountInfo<'info>,
    #[account(mut)]
    pub token_vault0: AccountInfo<'info>,
    #[account(mut)]
    pub token_vault1: AccountInfo<'info>,
    #[account(mut)]
    pub tick_array_lower: AccountInfo<'info>,
}
#[account]

#[derive(Default)]

pub struct Game {
    // 8
    pub other_mint: Pubkey,     //  +32
    pub total_deposited_a: u64, // + 8
    pub total_deposited_b: u64, // +8
    pub total_liquidity_a: u64, // +8
    pub total_liquidity_b: u64, // +8
    pub total_fee_a: u64,       // +8
    pub total_fee_b: u64,       // +8
    pub mint: Pubkey,           // 32
}
#[derive(Default, AnchorDeserialize, AnchorSerialize)]
pub struct PositionRef {
    pub tick_lower_index: i32,
    pub tick_upper_index: i32,
    pub i: i32,
    pub buff: [u8; 4]
}
#[account(zero_copy)]
#[derive(Default)]
pub struct PositionInfo {
    pub tick_lower_index: i32,          // 4
    pub tick_upper_index: i32,          // 4
    pub position_key: Pubkey,           // 32
    pub nft_account: Pubkey,
    pub winner_ata: Pubkey,
    pub pool_state: Pubkey, //token_mint_0.key() < token_mint_1.key(),
    pub i: i32,
    pub buff: [u8; 4]
}

#[derive(Accounts)]
pub struct ProxyOpenPosition<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(mut)]
    pub position_nft_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub position_nft_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init,
        payer = funder,
        token::authority = extra_account_meta_list,
        token::mint = position_nft_mint)]
    pub extra_nft_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut,
    constraint = (pool_state.load()?.token_mint_0 == Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap() || 
                 pool_state.load()?.token_mint_1 == Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap())
    )]
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(mut)]
    pub protocol_position: AccountInfo<'info>,
    #[account(mut)]
    pub personal_position: Account<'info, PersonalPositionState>,
    #[account(mut)]
    pub extra_token_account_0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub extra_token_account_1: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub token_vault_0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub token_vault_1: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub raydium_amm_v3_program: Program<'info, AmmV3>,
    #[account(init,
        payer = funder,
        space = 8 + std::mem::size_of::<PositionInfo>(),
        seeds = [&pool_state.load()?.tick_current.to_be_bytes()], 
        bump
    )]
    pub position_info: AccountLoader<'info, PositionInfo>,

    #[account(mut,
        realloc = game.to_account_info().data_len() + SPAN,
        realloc::zero = false,
        realloc::payer = funder,
        seeds = [b"gg", pool_state.key().as_ref()],  
        bump
    )]
    pub game: Box<Account<'info, Game>>,
    pub token_program_2022: Program<'info, Token2022>,
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub mint_2: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: AccountInfo<'info>,
    #[account(mut,
        token::mint = mint_2
    )]
    pub user_ata_2: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut,
        token::mint = mint
    )]
    pub user_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        seeds = [b"mint-authority"],
        bump
    )]
    pub mint_authority: SystemAccount<'info>,
    pub safe: AccountInfo<'info>
}
