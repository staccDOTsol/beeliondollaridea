
use anchor_lang::{
    prelude::*,
    system_program::{create_account, CreateAccount},
};


use core as core_;

pub const TICK_ARRAY_SEED: &str = "tick_array";
pub const TICK_ARRAY_SIZE_USIZE: usize = 60;
pub const TICK_ARRAY_SIZE: i32 = 60;
use jare_transfer_hook::{Game,PositionInfo, PositionRef};
use raydium_amm_v3::{libraries::{Q64, U256}, program::AmmV3, states::TickArrayState};
use raydium_amm_v3::{ accounts::{IncreaseLiquidity,DecreaseLiquidity}};
use raydium_amm_v3::states::{PersonalPositionState, PoolState};
use spl_token::solana_program::program_pack::Pack;
use raydium_amm_v3::libraries::MulDiv;

use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken}, token::{self, Token}, token_2022::Token2022, token_interface::{self, Mint, TokenAccount}
};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, state::ExtraAccountMetaList, seeds::Seed
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};
use std::{ops::Mul, str::FromStr, u64};

// transfer-hook program that charges a SOL fee on token transfer
// use a delegate and wrapped SOL because signers from initial transfer are not accessible

pub enum ComputeBudgetInstruction {
    Unused, // deprecated variant, reserved value.
    /// Request a specific transaction-wide program heap region size in bytes.
    /// The value requested must be a multiple of 1024. This new heap region
    /// size applies to each program executed in the transaction, including all
    /// calls to CPIs.
    RequestHeapFrame(u32),
    /// Set a specific compute unit limit that the transaction is allowed to consume.
    SetComputeUnitLimit(u32),
    /// Set a compute unit price in "micro-lamports" to pay a higher transaction
    /// fee for higher transaction prioritization.
    SetComputeUnitPrice(u64),
    /// Set a specific transaction-wide account data size limit, in bytes, is allowed to load.
    SetLoadedAccountsDataSizeLimit(u32),
}

declare_id!("Dercf2y55NPs7MeGgb4xi2NKfHwEm5X7K2xR5dPBGtCV");
use anchor_lang::prelude::Pubkey;

const SPAN: usize = std::mem::size_of::<PositionRef>();
use std::mem::size_of;
#[inline(never)]

fn find_best_position(
    game_data: &[u8],
    current_tick: i32,
    tick_spacing: u16,
    old_i: i32
) -> Option<(i32, i32, usize)> {
    let position_size = size_of::<PositionRef>();
    let num_positions = game_data.len() / position_size;

    let mut best_position = None;
    let mut best_range = i32::MAX;

    for i in (0..num_positions).rev() {
        // Randomize position start
        let position_start = i * position_size;
        if position_start + position_size > game_data.len() {
            continue;
        }

        if let Ok(position) = PositionRef::try_from_slice(&game_data[position_start..position_start + position_size]) {
            if position.tick_lower_index <= current_tick 
               && position.tick_upper_index >= current_tick
               && TickArrayState::get_array_start_index(position.tick_lower_index,tick_spacing) == position.i 
               && old_i != position.i 
            {
                let range = position.tick_upper_index - position.tick_lower_index;
                if range < best_range && range <= 10000 {
                    best_range = range;
                    return Some((
                        position.tick_lower_index, 
                        position.tick_upper_index, 
                        position.i as usize
                    ));
                }
            }
        }
    }

    best_position
}

#[inline(never)]
fn find_random_position(game_data: &[u8],tick_spacing: u16, old_i: i32) -> (i32, i32, usize) {
    let position_size = size_of::<PositionRef>();
    let num_positions = game_data.len() / position_size;

    let mut rng = Clock::get().unwrap().unix_timestamp as usize;

    for _ in 0..num_positions {
        rng = rng.wrapping_mul(1103515245).wrapping_add(12345);
        let position_index = rng % num_positions;
        let position_start = position_index * position_size;

        if position_start + position_size <= game_data.len() {
            if let Ok(position) = PositionRef::try_from_slice(&game_data[position_start..position_start + position_size]) {
                if position.tick_lower_index != 0
                    && position.tick_upper_index != 0
                    && TickArrayState::get_array_start_index(position.tick_lower_index, tick_spacing) == position.i
                    && old_i != position.i 
                {
                    return (position.tick_lower_index, position.tick_upper_index, position.i as usize);
                }
            }
        }
    }

    (0, 0, 0)
}


pub const POSITION_SEED: &str = "position";

pub fn get_tick_array_pubkeys(
    pool_id: &Pubkey,
    ticks: &[i32],
    tick_spacing: u16,
    program_id: &Pubkey
) -> Vec<i32> {
    //msg!("Starting get_tick_array_pubkeys function");
    let mut pubkeys = Vec::new();
    let mut unique_start_indices = std::collections::HashSet::new();

    //msg!("Processing {} ticks", ticks.len());
    for (i, &tick) in ticks.iter().enumerate() {
        //msg!("Processing tick {} at index {}", tick, i);
        let start_index = TickArrayState::get_array_start_index(tick, tick_spacing);
        //msg!("Calculated start_index: {}", start_index);
        
        if unique_start_indices.insert(start_index) {
            //msg!("New unique start_index found: {}", start_index);
           
            pubkeys.push(start_index);
        } else {
            //msg!("Duplicate start_index: {}, skipping", start_index);
        }
    }

    //msg!("Finished processing. Returning {} pubkeys", pubkeys.len());
    pubkeys
}
#[inline(never)]

// Helper function to create account metas
#[inline(never)]
fn create_account_metas(
    extra_account_meta_list_key: &Pubkey,
    position: &PositionInfo,
    winner_ata: &Pubkey,
    roll: bool,
    is_even_timestamp: bool,
    token_program_key: &Pubkey,
    mint_0: Pubkey,
    mint_1: Pubkey,
    position_ref: Option<(i32, i32, usize)>,
    token_account_0: Pubkey,
    token_account_1: Pubkey,
    
    token_vault_0: Pubkey,
    
    token_vault_1: Pubkey,
    tick_spacing:u16 ,
    heehee: ExtraAccountMeta      
    

) -> Result<Vec<ExtraAccountMeta>> {
    let hmm =   if position_ref.is_some() {  ExtraAccountMeta::new_external_pda_with_seeds(
        6,
        &[
            Seed::Literal { bytes: POSITION_SEED.as_bytes().to_vec() },
            Seed::AccountKey { index: 8},
            Seed::Literal { bytes: position_ref.unwrap().0.to_be_bytes().to_vec() },
            Seed::Literal { bytes:  position_ref.unwrap().1.to_be_bytes().to_vec() },
        ],
        false,
        true
    )? } else {
        ExtraAccountMeta::new_external_pda_with_seeds(
            6,
            &[
                Seed::Literal { bytes: POSITION_SEED.as_bytes().to_vec() },
                Seed::AccountKey { index: 8},
                Seed::Literal { bytes: position.tick_lower_index.to_be_bytes().to_vec() },
                Seed::Literal { bytes:  position.tick_upper_index.to_be_bytes().to_vec() },
            ],
            false,
            true
        )?
    };
    let mut account_metas = vec![
        ExtraAccountMeta::new_with_pubkey(extra_account_meta_list_key, false, true)?,
       heehee,
        ExtraAccountMeta::new_with_pubkey(&position.nft_account, false, false)?,
        ExtraAccountMeta::new_with_pubkey(&position.pool_state, false, true)?,
        ExtraAccountMeta::new_with_pubkey(&anchor_spl::token::ID, false, false)?, // 10
      hmm,
        ExtraAccountMeta::new_with_pubkey(&position.position_key, false, true)?,
    ];

    if roll {
        let one = anchor_spl::associated_token::get_associated_token_address(&position.winner_ata, &mint_0);
        let two = anchor_spl::associated_token::get_associated_token_address(&position.winner_ata, &mint_1);
        account_metas.push(ExtraAccountMeta::new_with_pubkey(
            if is_even_timestamp {
                winner_ata
            } else {
                &one
            },
            false,
            true,
        )?);
        account_metas.push(ExtraAccountMeta::new_with_pubkey(
            if is_even_timestamp {
                &two
            } else {
                winner_ata
            },
            false,
            true,
        )?);
    } else {
        account_metas.push(ExtraAccountMeta::new_with_pubkey(&token_account_0, false, true)?);
        account_metas.push(ExtraAccountMeta::new_with_pubkey(&token_account_1, false, true)?);

    }
    let tick_array_pubkeys = if position_ref.is_some()
      {get_tick_array_pubkeys(
        &position.pool_state,
        &[position_ref.unwrap().0, position_ref.unwrap().1],
        tick_spacing,
        &Pubkey::from_str("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK").unwrap()
        
    )  } 

    else  {get_tick_array_pubkeys(
        &position.pool_state,
        &[position.tick_lower_index, position.tick_upper_index],
        tick_spacing,
        &Pubkey::from_str("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK").unwrap()
    )
    };
    account_metas.push(ExtraAccountMeta::new_with_pubkey(&token_vault_0, false, true)?);

    account_metas.push(ExtraAccountMeta::new_with_pubkey(&token_vault_1, false, true)?);
    account_metas.extend([
    ExtraAccountMeta::new_external_pda_with_seeds(
        6,
        &[
            Seed::Literal { bytes: b"tick_array".to_vec() },
            Seed::AccountKey { index: 8},
            Seed::Literal { bytes: tick_array_pubkeys[0].to_be_bytes().to_vec() },
        ],
        false,
        true,
    )?,
    ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal { bytes:position_ref.unwrap().2.to_be_bytes().to_vec() } 
            ], false, true)?
    ]);

    Ok(account_metas)
}
/// Computes the amount of liquidity received for a given amount of token_1 and price range
/// Calculates ΔL = Δy / (√P_upper - √P_lower)
pub fn get_liquidity_from_amount_1(
    mut sqrt_ratio_a_x64: u128,
    mut sqrt_ratio_b_x64: u128,
    amount_1: u64,
) -> u128 {
    // sqrt_ratio_a_x64 should hold the smaller value
    if sqrt_ratio_a_x64 > sqrt_ratio_b_x64 {
        std::mem::swap(&mut sqrt_ratio_a_x64, &mut sqrt_ratio_b_x64);
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

    
#[inline(never)]
fn process_game_data<'a>(accounts: &'a [AccountInfo<'a>]) -> Result<()> {
    msg!("Starting process_game_data");

    msg!("Borrowing game data");
    let game_data = accounts[6].try_borrow_data()?;
    let game_data = &game_data[8 + std::mem::size_of::<Game>()..];
    
    msg!("Loading pool state");
    let pool_state = AccountLoader::<PoolState>::try_from(&accounts[8])?;
    let (current_tick, tick_spacing) = {let pool_state = pool_state.load()?;
        (pool_state.tick_current, pool_state.tick_spacing)
    };
    msg!("Current tick: {}", current_tick);

    msg!("Deserializing position info");
    let position_info = AccountLoader::<PositionInfo>::try_from(&accounts[15]);
    if position_info.is_ok() {
        let position_info = position_info.unwrap();
        let position_info = position_info.load()?;
    msg!("Selecting position");
   let  position_ref = select_position(&game_data, current_tick, position_info.i, tick_spacing);
    msg!("Selected position: {:?}", position_ref);

    msg!("Determining winner");
    let (winner, winner_ata) = determine_winner(accounts, &position_info);
    msg!("Winner: {}, Winner ATA: {}", winner, winner_ata);

    msg!("Creating optimized account metas");
   let  account_metas = create_optimized_account_metas(accounts, &position_info, &winner_ata, position_ref, pool_state)?;

    msg!("Creating CPI context");
    let cpi_ctx = CpiContext::new(
        accounts[14].clone(),
        jare_transfer_hook::cpi::accounts::TransferHook2 {
            extra_account_meta_list: accounts[5].clone()
        },
    );

    msg!("Calling jare_transfer_hook::cpi::process_game_data");
    jare_transfer_hook::cpi::process_game_data(cpi_ctx, position_ref.2 as u64,  position_ref.1, position_ref.0, position_info.tick_lower_index, position_info.tick_upper_index, tick_spacing, current_tick, account_metas.into_iter().map(|meta| meta.address_config).collect::<Vec<_>>())?;
}
    msg!("process_game_data completed successfully");
    Ok(())
}

#[inline(never)]
fn select_position(game_data: &[u8], current_tick: i32, old_i: i32, tick_spacing: u16) -> (i32, i32, usize) {
    if Clock::get().unwrap().unix_timestamp % 3 == 0 {
        find_random_position(game_data, tick_spacing, old_i)
    } else {
        find_best_position(game_data, current_tick, tick_spacing, old_i)
            .unwrap_or_else(|| find_random_position(game_data, tick_spacing, old_i))
    }
}

#[inline(never)]
fn determine_winner<'a>(accounts: &'a [AccountInfo], position_info: &PositionInfo) -> (Pubkey, Pubkey) {
    let chosen_mint = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap();
    let winner = if Clock::get().unwrap().unix_timestamp % 2 == 0 {
        accounts[3].key()
    } else {
        position_info.winner_ata
    };
    let winner_ata = anchor_spl::associated_token::get_associated_token_address(&winner, &chosen_mint);
    (winner, winner_ata)
}

#[inline(never)]
fn create_optimized_account_metas(
accounts: &[AccountInfo],
position_info: &PositionInfo,
winner_ata: &Pubkey,
position_ref: (i32, i32, usize),
pool_state: AccountLoader<PoolState>,
) -> Result<Vec<ExtraAccountMeta>> {
let pool_state = pool_state.load()?;
let tick_spacing = pool_state.tick_spacing;

// Pre-allocate the vector with the expected capacity to avoid reallocations
let mut account_metas = Vec::with_capacity(14);
// Roll a 2/4 chance
let roll_result = Clock::get().unwrap().unix_timestamp % 4;
let camm = Pubkey::from_str("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK").unwrap();

// Add static account metas
account_metas.extend_from_slice(&[
    ExtraAccountMeta::new_with_pubkey(&accounts[4].key(), false, true)?,
    ExtraAccountMeta::new_with_pubkey(if roll_result < 2 {
        &camm }
        
        else {
            &crate::ID

        }, false, false)?,
    ExtraAccountMeta::new_with_pubkey(&position_info.nft_account, false, false)?,
    ExtraAccountMeta::new_with_pubkey(&position_info.pool_state, false, true)?,
    ExtraAccountMeta::new_with_pubkey(&accounts[9].key(), false, false)?,
    ExtraAccountMeta::new_external_pda_with_seeds(
        6,
        &[
            Seed::Literal { bytes: POSITION_SEED.as_bytes().to_vec() },
            Seed::AccountKey { index: 8},
            Seed::Literal { bytes: position_info.tick_lower_index.to_be_bytes().to_vec() },
            Seed::Literal { bytes:  position_info.tick_upper_index.to_be_bytes().to_vec() },
        ],
        false,
        true
    )?,    ExtraAccountMeta::new_with_pubkey(&position_info.position_key, false, true)?,

]);
let usdc_mint = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap();
let current_tick = pool_state.tick_current;
let roll = current_tick < position_info.tick_lower_index || current_tick > position_info.tick_upper_index;

if pool_state.token_mint_0 == usdc_mint {
    if roll {
        account_metas.push(ExtraAccountMeta::new_with_pubkey(&winner_ata, false, true)?);
    } else {
        account_metas.push(ExtraAccountMeta::new_with_pubkey(&get_associated_token_address(&accounts[5].key(), &usdc_mint), false, true)?);
    }
}
else {
    account_metas.push(ExtraAccountMeta::new_with_pubkey(&accounts[10].key(), false, true)?);
} 

if pool_state.token_mint_1 == usdc_mint {
    if roll {
        account_metas.push(ExtraAccountMeta::new_with_pubkey(&winner_ata, false, true)?);
    } else {
        account_metas.push(ExtraAccountMeta::new_with_pubkey(&get_associated_token_address(&accounts[5].key(), &usdc_mint), false, true)?);
    }
} else {
    account_metas.push(ExtraAccountMeta::new_with_pubkey(&accounts[11].key(), false, true)?);
}
account_metas.push(ExtraAccountMeta::new_with_pubkey(&accounts[12].key(), false, true)?);
account_metas.push(ExtraAccountMeta::new_with_pubkey(&accounts[13].key(), false, true)?);

// Add tick array account meta
account_metas.push(ExtraAccountMeta::new_external_pda_with_seeds(
    6,
    &[
        Seed::Literal { bytes: TICK_ARRAY_SEED.as_bytes().to_vec() },
        Seed::AccountKey { index: 8 },
        Seed::Literal { bytes: TickArrayState::get_array_start_index(position_ref.0, pool_state.tick_spacing).to_le_bytes().to_vec() }
    ],
    false,
    true,
)?);
account_metas.push(    ExtraAccountMeta::new_with_seeds(
                    &[            Seed::Literal { bytes: position_info.i.to_be_bytes().to_vec() } 

                    ],
                    false,
                    true
                )?);

Ok(account_metas)
}
/// Computes the maximum amount of liquidity received for a given amount of token_0, token_1, the current
/// pool prices and the prices at the tick boundaries
pub fn get_liquidity_from_single_amount_1(
    sqrt_ratio_x64: u128,
    mut sqrt_ratio_a_x64: u128,
    mut sqrt_ratio_b_x64: u128,
    amount_1: u64,
) -> u128 {
    // sqrt_ratio_a_x64 should hold the smaller value
    if sqrt_ratio_a_x64 > sqrt_ratio_b_x64 {
        std::mem::swap(&mut sqrt_ratio_a_x64, &mut sqrt_ratio_b_x64);
    };

    if sqrt_ratio_x64 <= sqrt_ratio_a_x64 {
        // If P ≤ P_lower, only token_0 liquidity is active
        0
    } else if sqrt_ratio_x64 < sqrt_ratio_b_x64 {
        // If P_lower < P < P_upper, active liquidity is the minimum of the liquidity provided
        // by token_0 and token_1
        get_liquidity_from_amount_1(sqrt_ratio_a_x64, sqrt_ratio_x64, amount_1)
    } else {
        // If P ≥ P_upper, only token_1 liquidity is active
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
pub mod ecosystem_transfer_hook {
    use std::u64;

    use anchor_lang::solana_program::{
        program::{invoke},
        system_instruction,
    };
    
    use anchor_spl::{
        associated_token::{
            get_associated_token_address,
        },
        token_2022::{self, set_authority, MintTo, SetAuthority},
    };
    use spl_token::solana_program::instruction::Instruction;

    use super::*;
    
    pub fn initialize_first_extra_account_meta_list(
        ctx: Context<InitializeFirstExtraAccountMetaList>,
    ) -> Result<()> {
        //msg!("Starting initialize_first_extra_account_meta_list");
        let account_metas = vec![
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.solana_safer_mewn_extra_account_meta_lis.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.game_or_ray.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.nft_account.key(), false, false)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.pool_state.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_program.key(), false, false)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_account0.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_account1.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_vault0.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.token_vault1.key(), false, true)?,
            ExtraAccountMeta::new_with_pubkey(&jare_transfer_hook::ID, false, false)?,
            
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.position_info.key(), false, true)?,

        ];

        // Update ExtraAccountMetaList
        let required_size = ExtraAccountMetaList::size_of(account_metas.len())?;
        let current_size = ctx.accounts.extra_account_meta_list.data_len();

        if required_size > current_size {
            let lamports_required = Rent::get()?.minimum_balance(required_size);
            let lamports_current = ctx.accounts.extra_account_meta_list.lamports();

            if lamports_required > lamports_current {
                let lamports_to_add = lamports_required - lamports_current;
                invoke(
                    &system_instruction::transfer(
                        ctx.accounts.payer.key,
                        ctx.accounts.extra_account_meta_list.key,
                        lamports_to_add,
                    ),
                    &[
                        ctx.accounts.payer.to_account_info(),
                        ctx.accounts.extra_account_meta_list.to_account_info(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                )?;
            }

            ctx.accounts
                .extra_account_meta_list
                .realloc(required_size, false)?;
        }
    
        //msg!("Account metas created");

        //msg!("Account created");

        ExtraAccountMetaList::update::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        )?;
        //msg!("Game account mint updated");

        //msg!("initialize_first_extra_account_meta_list completed successfully");
        Ok(())
    }
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        if accounts.len() < 5 {
            let account_metas_address_configs = data;
             // Parse the account_metas_address_configs
             let mut account_metas_address_configs = Vec::new();
             let num_accounts = u64::from_le_bytes(data[..8].try_into().unwrap());
             let mut data = &data[8..];
             for _ in 0..num_accounts {
                 let address_config: [u8; 32] = data[..32].try_into().unwrap();
                 account_metas_address_configs.push(address_config);
                 data = &data[32..];
             }
             let pool_state: PoolState = *AccountLoader::try_from(&accounts[1])?.load()?;
             // Recreate account_metas from address_configs
             let mut account_metas = Vec::with_capacity(account_metas_address_configs.len());
    for (index, address_config) in account_metas_address_configs.clone().iter().enumerate() {
        let pubkey = Pubkey::new_from_array(*address_config);
        let is_signer = false;
        let is_writable = match index {
            0 | 1 | 2 | 3 | 5 | 6 | 7 | 8 | 9 => true,
            _ => false,
        };
        account_metas.push(ExtraAccountMeta::new_with_pubkey(&pubkey, is_signer, is_writable)?);
    }
        account_metas.push(            ExtraAccountMeta::new_external_pda_with_seeds(14, 
            &[
                Seed::Literal { bytes:TickArrayState::get_array_start_index(pool_state.tick_current, pool_state.tick_spacing).to_le_bytes().to_vec() }
            ]
            , false, true)?);
    ExtraAccountMetaList::update::<ExecuteInstruction>(
        &mut accounts[0].try_borrow_mut_data()?,
        &account_metas,
    )?;
    Ok(())
        }
        else {
        process_game_data(accounts)
        }
       
    }

}
#[derive(Accounts)]
pub struct InitializeFirstExtraAccountMetaList<'info> {
    #[account(mut)]
    payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"extra-account-metas", mint.key().as_ref()], 
        bump
    )]
    pub extra_account_meta_list: AccountInfo<'info>,
    #[account(mut
    )]
    pub solana_safer_mewn_extra_account_meta_lis: AccountInfo<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub system_program: Program<'info, System>,
    pub game_or_ray: AccountInfo<'info>,
    pub nft_account: AccountInfo<'info>,
    pub pool_state: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub token_account0: AccountInfo<'info>,
    pub token_account1: AccountInfo<'info>,
    pub token_vault0: AccountInfo<'info>,
    pub token_vault1: AccountInfo<'info>,
    pub position_info: AccountInfo<'info>,

}
#[derive(Accounts)]
pub struct TransferHook2<'info> {

    #[account(mut)]
    pub extra_account_meta_list: AccountInfo<'info>,
    pub pool_state: AccountLoader<'info, PoolState>
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
      //  extensions::transfer_hook::program_id = crate::id(),
      //  extensions::transfer_hook::authority = extra_account_meta_list,
      //  extensions::metadata_pointer::authority = funder,
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
}

// Order of accounts matters for this struct.
// The first 4 accounts are the accounts required for token transfer (source, mint, destination, owner)
// Remaining accounts are the extra accounts required from the ExtraAccountMetaList account
// These accounts are provided via CPI to this program from the token2022 program
#[derive(Accounts)]
pub struct TransferHook<'info> {
    pub source_token: AccountInfo<'info>, // 0
    pub mint: AccountInfo<'info>, // 1
    pub destination_token: AccountInfo<'info>, //2
    pub owner: AccountInfo<'info>, //3
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: AccountInfo<'info>, //4
    #[account(mut)]
    pub solana_safer_mewn_extra_account_meta_lis: AccountInfo<'info>, //5
    pub game_or_ray: AccountInfo<'info>, //6
    pub nft_account: AccountInfo<'info>, //7
    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>, //8
    pub token_program: AccountInfo<'info>, //9
    #[account(mut)]
    pub token_account0: AccountInfo<'info>, //10
    #[account(mut)]
    pub token_account1: AccountInfo<'info>, //11
    #[account(mut)]
    pub token_vault0: AccountInfo<'info>, //12
    #[account(mut)]
    pub token_vault1: AccountInfo<'info>, //13
    pub jare_transfe_hook: AccountInfo<'info>,
    #[account(mut)]
    pub position_info: AccountInfo<'info>, //14,
}
