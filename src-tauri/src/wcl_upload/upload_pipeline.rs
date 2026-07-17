use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::wcl_upload::core::WclSession;
use crate::wcl_upload::error::UploadError;
use crate::wcl_upload::parser::ParserBridge;
use crate::wcl_upload::payload::{
    build_fights_string, build_master_table_string, make_zip_payload,
};
use crate::wcl_upload::state::check_cancelled;
use crate::wcl_upload::types::{
    AddSegmentRequest, CollectFightsResponse, CollectMasterInfoResponse, MasterIds,
};

/// Uploads parser results while keeping report and master-table state together.
pub(crate) struct UploadPipeline<'a> {
    session: &'a WclSession,
    parser: &'a mut ParserBridge,
    report_code: &'a str,
    segment_id: &'a mut u64,
    last_master_ids: &'a mut Option<MasterIds>,
    cancel_flag: &'a Arc<AtomicBool>,
    pending_master_info: Option<CollectMasterInfoResponse>,
}

impl<'a> UploadPipeline<'a> {
    pub(crate) fn new(
        session: &'a WclSession,
        parser: &'a mut ParserBridge,
        report_code: &'a str,
        segment_id: &'a mut u64,
        last_master_ids: &'a mut Option<MasterIds>,
        cancel_flag: &'a Arc<AtomicBool>,
    ) -> Self {
        Self {
            session,
            parser,
            report_code,
            segment_id,
            last_master_ids,
            cancel_flag,
            pending_master_info: None,
        }
    }

    pub(crate) fn prepare_master_info(&mut self) -> Result<bool, UploadError> {
        let master_info = self.parser.collect_master_info()?;
        let current_master_ids = MasterIds {
            actor_id: master_info.last_assigned_actor_id,
            ability_id: master_info.last_assigned_ability_id,
            tuple_id: master_info.last_assigned_tuple_id,
            pet_id: master_info.last_assigned_pet_id,
        };
        let changed = Some(current_master_ids) != *self.last_master_ids;
        self.pending_master_info = Some(master_info);
        Ok(changed)
    }

    pub(crate) fn upload_segment(
        &mut self,
        fights_data: &CollectFightsResponse,
        is_live_log: bool,
    ) -> Result<(u64, bool), UploadError> {
        check_cancelled(self.cancel_flag)?;

        let master_info = match self.pending_master_info.take() {
            Some(master_info) => master_info,
            None => self.parser.collect_master_info()?,
        };
        let current_master_ids = MasterIds {
            actor_id: master_info.last_assigned_actor_id,
            ability_id: master_info.last_assigned_ability_id,
            tuple_id: master_info.last_assigned_tuple_id,
            pet_id: master_info.last_assigned_pet_id,
        };

        let master_uploaded = Some(current_master_ids) != *self.last_master_ids;
        if master_uploaded {
            check_cancelled(self.cancel_flag)?;
            let master_payload = build_master_table_string(
                &master_info,
                fights_data.log_version,
                fights_data.game_version,
            );
            self.session.set_master_table(
                self.report_code,
                *self.segment_id,
                make_zip_payload(&master_payload)?,
            )?;
            *self.last_master_ids = Some(current_master_ids);
        }

        check_cancelled(self.cancel_flag)?;
        let total_events = fights_data
            .fights
            .iter()
            .map(|fight| fight.event_count)
            .sum();
        let fights_payload = build_fights_string(fights_data);
        *self.segment_id = self.session.add_segment(AddSegmentRequest {
            report_code: self.report_code.to_string(),
            segment_id: *self.segment_id,
            start_time: fights_data.start_time,
            end_time: fights_data.end_time,
            mythic: fights_data.mythic,
            is_live_log,
            zip_bytes: make_zip_payload(&fights_payload)?,
        })?;

        self.parser.clear_fights()?;
        Ok((total_events, master_uploaded))
    }
}
