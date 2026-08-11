-- phpMyAdmin SQL Dump
-- version 5.2.3
-- https://www.phpmyadmin.net/
--
-- Host: localhost:3306
-- Generation Time: Aug 10, 2026 at 08:10 AM
-- Server version: 10.11.18-MariaDB-cll-lve
-- PHP Version: 8.4.24

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `crowd4testDB`
--

-- --------------------------------------------------------

--
-- Table structure for table `active_plans`
--

CREATE TABLE `active_plans` (
  `act_pid` int(20) NOT NULL,
  `org_id` int(20) DEFAULT NULL,
  `plan_name` enum('private','diy','managed') DEFAULT NULL,
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `remaining_projects` int(20) DEFAULT NULL,
  `remaining_private_testers` int(20) DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `announcements`
--

CREATE TABLE `announcements` (
  `id` int(200) NOT NULL,
  `A_build_id` int(100) NOT NULL,
  `A_body` longtext NOT NULL,
  `A_added_by` int(100) NOT NULL,
  `A_added_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `A_updated_date` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `applied_tests`
--

CREATE TABLE `applied_tests` (
  `apt_id` int(11) NOT NULL,
  `apt_tester_id` int(11) NOT NULL DEFAULT 0,
  `apt_project_id` int(11) NOT NULL DEFAULT 0,
  `apt_add_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `apt_add_by` int(11) NOT NULL DEFAULT 0
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci COMMENT='one tester can appliy any number of tests';

-- --------------------------------------------------------

--
-- Table structure for table `app_types`
--

CREATE TABLE `app_types` (
  `at_id` int(11) NOT NULL,
  `at_name` varchar(100) DEFAULT NULL,
  `at_desc` varchar(200) DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci COMMENT='aaplication types - desktop/wesbite/app';

-- --------------------------------------------------------

--
-- Table structure for table `assigned_tests`
--

CREATE TABLE `assigned_tests` (
  `ast_id` int(11) NOT NULL,
  `ast_build_id` int(11) NOT NULL DEFAULT 0,
  `ast_tester_id` int(11) NOT NULL DEFAULT 0 COMMENT 'a tester to whom test has been assigned ',
  `ast_test_status_id` int(11) NOT NULL DEFAULT 0,
  `ast_add_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `ast_add_by` int(11) NOT NULL DEFAULT 0,
  `ast_devices` varchar(300) DEFAULT NULL,
  `ast_browsers` varchar(300) DEFAULT NULL,
  `ast_language` varchar(255) DEFAULT NULL,
  `rate` varchar(20) DEFAULT NULL,
  `feedback` varchar(200) DEFAULT NULL,
  `rate_by` varchar(20) DEFAULT NULL,
  `credit` varchar(20) DEFAULT NULL,
  `tc` varchar(20) DEFAULT NULL,
  `ast_pmt_status` enum('paid','not_paid') NOT NULL DEFAULT 'not_paid'
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci COMMENT='one test can be assigned to multiple testers ';

-- --------------------------------------------------------

--
-- Table structure for table `assign_testCase`
--

CREATE TABLE `assign_testCase` (
  `Sno` int(20) NOT NULL,
  `case_id` varchar(1500) NOT NULL,
  `tester_id` varchar(1000) NOT NULL,
  `build_id` varchar(20) NOT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `attachments`
--

CREATE TABLE `attachments` (
  `attach_id` int(11) NOT NULL,
  `attach_title` varchar(100) NOT NULL,
  `attach_type` varchar(100) DEFAULT NULL,
  `attach_filename` varchar(100) DEFAULT NULL,
  `attach_loc_server` varchar(100) DEFAULT NULL,
  `attach_bugs_report_id` int(11) NOT NULL COMMENT 'Bugs Report Id',
  `attach_created_by` int(11) NOT NULL COMMENT 'User Id who uploaded the document',
  `attach_created_date` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci COMMENT='Organisation created while adding Customer';

-- --------------------------------------------------------

--
-- Table structure for table `automation_modules`
--

CREATE TABLE `automation_modules` (
  `tc_id` int(100) NOT NULL,
  `tc_module_id` varchar(100) NOT NULL,
  `tc_module_name` varchar(500) DEFAULT NULL,
  `tc_steps` text NOT NULL,
  `tc_expected_result` text NOT NULL,
  `tc_build_id` varchar(50) NOT NULL,
  `tc_project_id` varchar(50) NOT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `automation_reports`
--

CREATE TABLE `automation_reports` (
  `ID` int(11) NOT NULL,
  `report` varchar(255) NOT NULL,
  `selectedModules` varchar(5000) DEFAULT NULL,
  `selectedScripts` varchar(10000) DEFAULT NULL,
  `build` varchar(20) NOT NULL,
  `project` varchar(20) NOT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `base_country`
--

CREATE TABLE `base_country` (
  `id` int(11) NOT NULL,
  `iso2` char(2) DEFAULT NULL,
  `iso3` char(3) DEFAULT NULL,
  `name_en` varchar(64) DEFAULT NULL,
  `name_fr` varchar(64) DEFAULT NULL,
  `name_de` varchar(64) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `browsers`
--

CREATE TABLE `browsers` (
  `brw_id` int(11) NOT NULL,
  `brw_name` varchar(50) DEFAULT NULL,
  `brw_desc` varchar(50) DEFAULT NULL,
  `brw_image` varchar(100) NOT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `browser_versions`
--

CREATE TABLE `browser_versions` (
  `version_id` int(11) NOT NULL,
  `browser_id` int(11) NOT NULL,
  `version` varchar(30) NOT NULL,
  `created_by` int(11) NOT NULL,
  `created_date` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `bugs_report`
--

CREATE TABLE `bugs_report` (
  `bug_id` int(11) NOT NULL,
  `bug_project_id` int(11) NOT NULL COMMENT 'Refers Project Table',
  `bug_build_id` int(11) NOT NULL COMMENT 'Refers Build Table',
  `bug_defect_id` varchar(50) DEFAULT NULL COMMENT 'Unique Id for Crash or Defect',
  `bug_type` varchar(20) DEFAULT NULL,
  `bug_typeofdefect` varchar(55) DEFAULT NULL COMMENT ' Type Of Defect = UI, Usability, Functionality',
  `defect_sub_type` varchar(30) DEFAULT NULL,
  `bug_reproducibility` varchar(50) DEFAULT NULL COMMENT 'Defect Reproduce always,sometimes',
  `sometimeFreq` varchar(5) DEFAULT NULL,
  `sometimeTotal` varchar(5) DEFAULT NULL,
  `bug_severity` varchar(50) DEFAULT NULL COMMENT 'Defect Severity critical, major ,minor',
  `bug_device_used` varchar(255) NOT NULL COMMENT 'Devices used',
  `bug_browsers_used` varchar(255) DEFAULT NULL COMMENT 'Browsers used',
  `bug_feature` varchar(200) DEFAULT NULL,
  `bug_desc` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Crash or Defect Desc',
  `bug_pre_condition` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Defect Pre Condition',
  `bug_steps` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Defect Steps',
  `bug_exp_result` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Defect Expected Results',
  `bug_actual_result` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Defect Actual Results',
  `bug_video_url` longtext DEFAULT NULL,
  `bug_screen1` varchar(255) DEFAULT NULL,
  `bug_screen2` varchar(255) DEFAULT NULL,
  `bug_attachment` varchar(255) DEFAULT NULL,
  `bug_created_by` int(11) DEFAULT NULL COMMENT 'Defect or Crash Created By',
  `bug_updated_by` int(11) DEFAULT NULL COMMENT 'Defect or Crash Updated By',
  `bug_created_date` timestamp NULL DEFAULT current_timestamp() COMMENT 'Defect or Crash Created Time',
  `bug_updated_date` timestamp NULL DEFAULT NULL COMMENT 'Defect or Crash Updated Time',
  `bug_status` int(11) NOT NULL COMMENT '0=>Normal,1=>duplicate,2=>invalid',
  `bug_export_jira` int(2) NOT NULL DEFAULT 0,
  `bug_assign_test_id` int(11) DEFAULT NULL,
  `bug_title` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Crash Title',
  `bug_type_id` int(11) DEFAULT NULL COMMENT 'Refers bug_types',
  `bug_ln_defect_type` varchar(100) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `bug_types`
--

CREATE TABLE `bug_types` (
  `bt_id` int(11) NOT NULL,
  `bt_title` varchar(255) DEFAULT NULL,
  `bt_desc` text DEFAULT NULL COMMENT 'Crash or Defect Desc',
  `bt_created_by` int(11) DEFAULT NULL,
  `bt_updated_by` int(11) DEFAULT NULL,
  `bt_created_date` timestamp NULL DEFAULT current_timestamp(),
  `bt_updated_date` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `builds`
--

CREATE TABLE `builds` (
  `build_id` int(11) NOT NULL,
  `project_id` int(11) NOT NULL COMMENT 'Project Id to which build belongs',
  `build_customize_bug` enum('yes','no') NOT NULL DEFAULT 'no',
  `build_test_type_id` int(11) NOT NULL,
  `build_version_desc` varchar(255) DEFAULT NULL COMMENT 'Build Description or version name',
  `build_app_link` varchar(400) DEFAULT NULL,
  `build_desc` text DEFAULT NULL COMMENT 'detailed description',
  `build_scope` text NOT NULL,
  `build_feature_list` varchar(255) DEFAULT NULL,
  `build_devices` varchar(255) NOT NULL,
  `build_browsers` varchar(255) NOT NULL,
  `build_browser_spec` int(11) DEFAULT NULL,
  `build_os` varchar(255) NOT NULL,
  `build_os_spec` int(11) DEFAULT NULL,
  `TestCountry` varchar(255) DEFAULT NULL,
  `build_languages` varchar(500) DEFAULT NULL,
  `build_start_date` date NOT NULL,
  `build_end_date` date NOT NULL,
  `doc_id` int(11) DEFAULT NULL,
  `build_add_by` int(11) DEFAULT NULL,
  `build_upd_by` int(11) DEFAULT NULL,
  `build_add_date` timestamp NULL DEFAULT current_timestamp(),
  `build_upd_date` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `build_test_scenario` varchar(255) DEFAULT NULL,
  `build_per_test_type` enum('load_test','stress_test','soak_test','soike_test') DEFAULT NULL,
  `build_per_protocol` enum('http','https','tcp','ftp') DEFAULT NULL,
  `build_per_load` int(100) DEFAULT NULL,
  `build_cycle_type` enum('crowd','private','managed','diy') DEFAULT 'private',
  `build_release_notes` text DEFAULT NULL COMMENT 'Build release notes',
  `build_version_no` varchar(50) DEFAULT NULL COMMENT 'Build version number',
  `build_apk_file` varchar(100) DEFAULT '0',
  `build_testdata` varchar(1000) NOT NULL DEFAULT '0',
  `build_testers` int(11) NOT NULL,
  `build_pricing_model` enum('tester_credit','hourly_rate','bug_bounty') DEFAULT 'tester_credit',
  `tester_reward` int(50) DEFAULT NULL,
  `rewards_currency` enum('$','INR') DEFAULT NULL,
  `build_outof_scope` text NOT NULL,
  `invited_testers` longtext DEFAULT NULL,
  `build_test_status` enum('new','assigned','tested','reviewed','closed') DEFAULT 'new',
  `build_document` varchar(255) DEFAULT NULL,
  `others_bug_visibility` enum('yes','no') DEFAULT 'yes'
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci COMMENT='Builds created by Customers';

-- --------------------------------------------------------

--
-- Table structure for table `build_reports`
--

CREATE TABLE `build_reports` (
  `brep_id` int(100) NOT NULL,
  `brep_file_name` varchar(500) NOT NULL,
  `brep_build_id` int(100) NOT NULL,
  `brep_user_id` int(100) NOT NULL,
  `brep_time` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `ci_sessions`
--

CREATE TABLE `ci_sessions` (
  `id` varchar(128) NOT NULL,
  `ip_address` varchar(45) NOT NULL,
  `timestamp` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `data` blob NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `comments_monitor`
--

CREATE TABLE `comments_monitor` (
  `monitor_id` int(11) NOT NULL,
  `bug_id` int(11) NOT NULL,
  `comments_id` int(11) NOT NULL,
  `written_by` int(11) NOT NULL,
  `written_to` int(11) NOT NULL,
  `user_read` tinyint(4) NOT NULL,
  `created_date` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contests`
--

CREATE TABLE `contests` (
  `contest_id` int(11) NOT NULL,
  `org_id` int(11) NOT NULL,
  `contest_title` varchar(100) DEFAULT NULL,
  `contest_desc` text DEFAULT NULL,
  `contest_objective` text DEFAULT NULL,
  `contest_guidelines` text DEFAULT NULL,
  `contest_data` text DEFAULT NULL,
  `contest_start_time` date NOT NULL,
  `contest_end_time` date NOT NULL,
  `max_participants` int(10) DEFAULT NULL,
  `contest_logo` varchar(100) DEFAULT NULL,
  `contest_prizes` int(3) DEFAULT NULL,
  `first_prize` int(11) DEFAULT NULL,
  `second_prize` int(11) DEFAULT NULL,
  `third_prize` int(11) DEFAULT NULL,
  `fourth_prize` int(11) DEFAULT NULL,
  `fifth_prize` int(11) DEFAULT NULL,
  `contest_app_link` varchar(200) DEFAULT NULL,
  `contest_attachment` varchar(150) DEFAULT NULL,
  `contest_min_age` int(50) DEFAULT NULL,
  `contest_max_age` int(50) DEFAULT NULL,
  `contest_gender` enum('Male','Female','Others') DEFAULT NULL,
  `contest_countries` varchar(255) DEFAULT NULL,
  `employment` varchar(255) DEFAULT NULL,
  `industry` varchar(255) DEFAULT NULL,
  `parental_status` varchar(255) DEFAULT NULL,
  `contest_type` enum('Web','Mobile') DEFAULT NULL,
  `contest_os_type` varchar(100) DEFAULT NULL,
  `contest_created_by` int(11) NOT NULL,
  `invited_participants` longtext DEFAULT NULL,
  `joined_participants` longtext DEFAULT NULL,
  `contest_created_date` timestamp NULL DEFAULT NULL,
  `contest_updated_date` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `contest_customize_feedback` enum('yes','no') NOT NULL DEFAULT 'no'
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contest_answers`
--

CREATE TABLE `contest_answers` (
  `answer_id` int(11) NOT NULL,
  `contest_id` int(11) NOT NULL,
  `participant_id` int(11) NOT NULL,
  `question_id` int(11) NOT NULL,
  `answer` text NOT NULL,
  `answer_submition_time` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `video_url` varchar(255) DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contest_feedback`
--

CREATE TABLE `contest_feedback` (
  `feedback_id` int(11) NOT NULL,
  `participant_id` int(11) NOT NULL,
  `contest_id` int(11) NOT NULL,
  `feedback_title` text DEFAULT NULL,
  `feedback` longtext DEFAULT NULL,
  `feedback_devices` varchar(20) DEFAULT NULL,
  `feedback_browsers` varchar(20) DEFAULT NULL,
  `feedback_time` timestamp NOT NULL DEFAULT current_timestamp(),
  `feedback_attachment` varchar(255) DEFAULT NULL,
  `feedback_video_url` longtext DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contest_participant`
--

CREATE TABLE `contest_participant` (
  `participant_id` int(11) NOT NULL,
  `participant_user_id` int(11) NOT NULL,
  `contest_id` int(11) NOT NULL,
  `invitation_time` timestamp NOT NULL DEFAULT current_timestamp(),
  `joining_time` timestamp NULL DEFAULT NULL,
  `submission_time` timestamp NULL DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contest_question`
--

CREATE TABLE `contest_question` (
  `question_id` int(11) NOT NULL,
  `contest_id` int(11) NOT NULL,
  `survey_type` enum('pre','post','task') DEFAULT NULL,
  `question` longtext NOT NULL,
  `answer_type` enum('descriptive','scale','multichoice','checkbox','number','verbal') DEFAULT NULL,
  `choice_A` varchar(100) DEFAULT NULL,
  `choice_B` varchar(100) DEFAULT NULL,
  `choice_C` varchar(100) DEFAULT NULL,
  `choice_D` varchar(100) DEFAULT NULL,
  `choice_E` varchar(100) DEFAULT NULL,
  `choice_F` varchar(100) NOT NULL,
  `question_created_time` timestamp NULL DEFAULT NULL,
  `question_updated_time` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `appear_date` date DEFAULT NULL,
  `task_id` int(50) DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `contest_tasks`
--

CREATE TABLE `contest_tasks` (
  `task_id` int(50) NOT NULL,
  `contest_id` int(50) NOT NULL,
  `task_name` varchar(255) DEFAULT NULL,
  `task_apear_date` date DEFAULT NULL,
  `task_created_time` timestamp NULL DEFAULT current_timestamp(),
  `task_updated_time` timestamp NULL DEFAULT NULL ON UPDATE current_timestamp(),
  `task_created_by` int(20) DEFAULT NULL,
  `task_updated_by` int(20) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `cust_bug_answers`
--

CREATE TABLE `cust_bug_answers` (
  `cbfa_id` int(255) NOT NULL,
  `cbfa_fid` int(255) NOT NULL,
  `cbfa_build_id` int(100) DEFAULT NULL,
  `cbfa_bug_id` int(100) DEFAULT NULL,
  `cbfa_answer` text NOT NULL,
  `cbfa_add_by` int(100) NOT NULL,
  `cbfa_add_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `cbfa_upd_date` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `cust_bug_fields`
--

CREATE TABLE `cust_bug_fields` (
  `cbf_id` int(100) NOT NULL,
  `cbf_build_id` int(50) DEFAULT NULL,
  `cbf_name` varchar(255) DEFAULT NULL,
  `cbf_type` enum('text','dropdown','checkbox','number','boolean') NOT NULL DEFAULT 'text',
  `cbf_opt_A` varchar(100) DEFAULT NULL,
  `cbf_opt_B` varchar(100) DEFAULT NULL,
  `cbf_opt_C` varchar(100) DEFAULT NULL,
  `cbf_opt_D` varchar(100) DEFAULT NULL,
  `cbf_opt_E` varchar(100) DEFAULT NULL,
  `cbf_opt_F` varchar(100) DEFAULT NULL,
  `cbf_add_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `cbf_upd_date` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `cust_feedback_answers`
--

CREATE TABLE `cust_feedback_answers` (
  `cffa_id` int(30) NOT NULL,
  `cffa_fid` int(30) NOT NULL,
  `contest_id` int(30) NOT NULL,
  `feedback_id` int(30) NOT NULL,
  `cffa_answer` varchar(255) DEFAULT NULL,
  `cffa_added_by` int(30) NOT NULL,
  `cffa_added_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `cffa_updated_date` timestamp NULL DEFAULT NULL ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `cust_feedback_fields`
--

CREATE TABLE `cust_feedback_fields` (
  `cff_id` int(30) NOT NULL,
  `contest_id` int(20) DEFAULT NULL,
  `cff_name` varchar(50) DEFAULT NULL,
  `cff_type` enum('text','dropdown') NOT NULL DEFAULT 'text',
  `cff_opt_A` varchar(20) DEFAULT NULL,
  `cff_opt_B` varchar(20) DEFAULT NULL,
  `cff_opt_C` varchar(20) DEFAULT NULL,
  `cff_opt_D` varchar(20) DEFAULT NULL,
  `cff_opt_E` varchar(20) DEFAULT NULL,
  `cff_opt_F` varchar(20) DEFAULT NULL,
  `cff_added_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `cff_updated_date` timestamp NULL DEFAULT NULL ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `defect_comments`
--

CREATE TABLE `defect_comments` (
  `comments_id` int(11) NOT NULL,
  `comments_build_id` int(11) NOT NULL,
  `comments_bug_id` int(11) NOT NULL,
  `comments_comment` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `comments_attach1` varchar(255) NOT NULL,
  `comments_attach2` varchar(255) NOT NULL,
  `comments_done_by` int(11) NOT NULL,
  `comments_date` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `devices`
--

CREATE TABLE `devices` (
  `dvc_id` int(11) NOT NULL,
  `dvc_manufacturer` int(11) DEFAULT NULL,
  `dvc_name` varchar(50) DEFAULT NULL,
  `dvc_desc` varchar(50) DEFAULT NULL,
  `dvc_manufacturer_name` varchar(100) NOT NULL DEFAULT '0',
  `dvc_mob_os_ver_id` int(11) DEFAULT NULL,
  `dvc_os_details` varchar(500) NOT NULL DEFAULT '0',
  `dvc_ram` int(10) DEFAULT NULL,
  `dvc_screen` double DEFAULT NULL,
  `dvc_primary_network` int(50) DEFAULT NULL,
  `dvc_secondary_network` int(50) DEFAULT NULL,
  `dvc_add_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `dvc_add_by` int(11) NOT NULL DEFAULT 0,
  `dvc_updated_date` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `dvc_deleted_date` timestamp NULL DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci COMMENT='devices-iphone,PC';

-- --------------------------------------------------------

--
-- Table structure for table `documents`
--

CREATE TABLE `documents` (
  `doc_id` int(11) NOT NULL,
  `doc_title` varchar(100) NOT NULL,
  `doc_type` varchar(100) DEFAULT NULL,
  `doc_filename` varchar(100) DEFAULT NULL,
  `doc_loc_server` varchar(100) DEFAULT NULL,
  `doc_project_id` int(11) NOT NULL COMMENT 'Project Id',
  `doc_build_id` int(11) NOT NULL,
  `doc_created_by` int(11) NOT NULL COMMENT 'User Id who uploaded the document',
  `doc_created_date` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci COMMENT='Organisation created while adding Customer';

-- --------------------------------------------------------

--
-- Table structure for table `marketing`
--

CREATE TABLE `marketing` (
  `Sno` int(11) NOT NULL,
  `FirstName` varchar(255) NOT NULL,
  `LastName` varchar(255) DEFAULT NULL,
  `Email` varchar(255) DEFAULT NULL,
  `Location` varchar(500) DEFAULT NULL,
  `Phone` varchar(255) DEFAULT NULL,
  `organization` varchar(255) DEFAULT NULL,
  `date` varchar(255) DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `message`
--

CREATE TABLE `message` (
  `id` int(200) NOT NULL,
  `creator_id` int(50) NOT NULL,
  `message_body` longtext DEFAULT NULL,
  `create_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `deleted_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `message_recipient`
--

CREATE TABLE `message_recipient` (
  `id` int(200) NOT NULL,
  `recipient_id` int(50) NOT NULL,
  `message_id` int(200) NOT NULL,
  `is_read` enum('0','1') NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `mobile_brands`
--

CREATE TABLE `mobile_brands` (
  `mbr_id` int(11) NOT NULL,
  `mbr_name` varchar(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `mobile_os_type`
--

CREATE TABLE `mobile_os_type` (
  `ost_id` int(11) NOT NULL,
  `ost_name` varchar(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `mobile_os_version`
--

CREATE TABLE `mobile_os_version` (
  `mov_id` int(11) NOT NULL,
  `mov_type_id` int(11) NOT NULL,
  `mov_name` varchar(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `network_providers`
--

CREATE TABLE `network_providers` (
  `network_id` int(20) NOT NULL,
  `network_name` varchar(100) DEFAULT NULL,
  `network_country` varchar(100) DEFAULT NULL,
  `network_desc` varchar(200) DEFAULT NULL,
  `network_image` varchar(100) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `notification`
--

CREATE TABLE `notification` (
  `Sno` int(11) NOT NULL,
  `org` varchar(255) NOT NULL,
  `allN` varchar(255) DEFAULT NULL,
  `buildStatus` varchar(255) DEFAULT NULL,
  `criticalDef` varchar(255) DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `organisation`
--

CREATE TABLE `organisation` (
  `org_id` int(11) NOT NULL,
  `org_title` varchar(100) DEFAULT NULL,
  `org_image` varchar(100) NOT NULL DEFAULT '',
  `org_address` varchar(100) DEFAULT '',
  `org_desc` text DEFAULT NULL COMMENT 'Detailed description',
  `credit_rate` varchar(20) DEFAULT NULL,
  `test_manager_fee` varchar(20) DEFAULT NULL,
  `active_plan_id` varchar(50) DEFAULT NULL,
  `org_wallet_balance` int(50) DEFAULT NULL,
  `org_created_by` int(11) NOT NULL,
  `org_update_by` int(11) DEFAULT NULL,
  `org_created_date` timestamp NULL DEFAULT current_timestamp(),
  `org_update_date` timestamp NOT NULL DEFAULT '0000-00-00 00:00:00',
  `locked_amount` int(100) DEFAULT NULL,
  `org_currency` enum('$','INR') DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci COMMENT='Organisation created while adding Customer';

-- --------------------------------------------------------

--
-- Table structure for table `os`
--

CREATE TABLE `os` (
  `os_id` int(11) NOT NULL,
  `os_name` varchar(50) DEFAULT NULL,
  `os_desc` varchar(50) DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci COMMENT='Operating Systems';

-- --------------------------------------------------------

--
-- Table structure for table `os_versions`
--

CREATE TABLE `os_versions` (
  `os_id` int(11) NOT NULL,
  `os_type_id` int(11) NOT NULL,
  `os_name` varchar(50) DEFAULT NULL,
  `os_desc` varchar(50) DEFAULT NULL,
  `os_image` varchar(100) NOT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `payment_acc_details`
--

CREATE TABLE `payment_acc_details` (
  `pmt_id` int(11) NOT NULL,
  `pmt_user_id` int(11) NOT NULL,
  `pmt_country` enum('Indian','Non-indian') NOT NULL,
  `pmt_payment_type` enum('ind_bank_acc','non-ind_bank_acc','paypal','paytm') DEFAULT NULL,
  `pmt_account_name` varchar(255) DEFAULT NULL,
  `pmt_account_no` varchar(25) DEFAULT NULL,
  `pmt_bank_name` varchar(255) DEFAULT NULL,
  `pmt_branch_name` varchar(255) DEFAULT NULL,
  `pmt_ifsc_code` varchar(25) DEFAULT NULL,
  `pmt_paypal_email` varchar(255) DEFAULT NULL,
  `pmt_paytm_number` varchar(10) DEFAULT NULL,
  `pmt_status` enum('Active','Inactive') NOT NULL DEFAULT 'Active',
  `pmt_timestamp` bigint(11) NOT NULL,
  `pmt_acc_updated` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `payment_history`
--

CREATE TABLE `payment_history` (
  `pmt_id` int(11) NOT NULL,
  `pmt_user_id` int(11) NOT NULL,
  `pmt_for_build_id` varchar(100) DEFAULT NULL,
  `pmt_for_contest_id` varchar(50) DEFAULT NULL,
  `pmt_type` enum('credit','debit','release') NOT NULL,
  `pmt_method` enum('ind_bank_acc','non-ind_bank_acc','paypal','paytm') DEFAULT NULL,
  `pmt_method_details` varchar(50) DEFAULT NULL,
  `pmt_amount` bigint(11) NOT NULL,
  `pmt_in` varchar(5) DEFAULT NULL,
  `pmt_summary` varchar(255) NOT NULL,
  `pmt_status` enum('new','seen') NOT NULL DEFAULT 'new',
  `pmt_time` bigint(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `permissions`
--

CREATE TABLE `permissions` (
  `per_id` int(11) NOT NULL,
  `per_roleid` int(11) DEFAULT 0,
  `per_resourceid` int(11) DEFAULT 0
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `pricing_models`
--

CREATE TABLE `pricing_models` (
  `pm_id` int(11) NOT NULL,
  `pm_name` varchar(50) DEFAULT '0',
  `pm_desc` varchar(500) DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `projects`
--

CREATE TABLE `projects` (
  `project_id` int(11) NOT NULL,
  `org_id` int(11) NOT NULL,
  `project_title` varchar(100) DEFAULT NULL,
  `project_app_type_id` int(11) DEFAULT NULL COMMENT 'type of application [drop down] (values : mobille app , website, desktop app)',
  `project_devices` varchar(500) DEFAULT NULL COMMENT 'devices on which to be test - (text area )(user will add comma seprated list)',
  `project_os_id` int(11) NOT NULL DEFAULT 0 COMMENT 'Operating system (drop down box) (val: android os, ios, windows, )',
  `project_browsers` varchar(500) DEFAULT NULL COMMENT 'textarea- information with versions',
  `project_image_icon` varchar(100) NOT NULL DEFAULT '',
  `project_testdata` varchar(500) NOT NULL DEFAULT '',
  `project_desc` text DEFAULT NULL COMMENT 'Detailed description',
  `project_scope` text DEFAULT NULL,
  `project_testers` int(11) NOT NULL,
  `project_outof_scope` text DEFAULT NULL,
  `project_test_type_id` int(11) NOT NULL DEFAULT 0,
  `project_pricing_model_id` int(11) NOT NULL DEFAULT 0,
  `project_cycle_type` enum('crowd','private','managed','diy') NOT NULL DEFAULT 'private',
  `project_created_by` int(11) NOT NULL,
  `project_update_by` int(11) DEFAULT NULL,
  `project_created_date` timestamp NULL DEFAULT current_timestamp(),
  `project_update_date` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `export_project_key` varchar(20) DEFAULT NULL,
  `project_test_lang` varchar(1000) DEFAULT NULL,
  `project_manager` varchar(50) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci COMMENT='Projects created by Customers';

-- --------------------------------------------------------

--
-- Table structure for table `resources`
--

CREATE TABLE `resources` (
  `res_id` int(11) NOT NULL,
  `res_name` varchar(50) DEFAULT NULL,
  `res_desc` varchar(50) DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `roles`
--

CREATE TABLE `roles` (
  `rol_id` int(11) NOT NULL,
  `rol_name` varchar(50) DEFAULT NULL,
  `rol_desc` varchar(50) DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `site_settings`
--

CREATE TABLE `site_settings` (
  `id` int(11) NOT NULL,
  `key_name` varchar(50) NOT NULL,
  `key_value` varchar(50) NOT NULL,
  `created_by` int(11) NOT NULL,
  `created_date` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `site_statistics`
--

CREATE TABLE `site_statistics` (
  `stat_id` int(11) NOT NULL,
  `stat_date` varchar(20) NOT NULL,
  `stat_logins` int(11) NOT NULL DEFAULT 0,
  `stat_new_test` int(11) NOT NULL DEFAULT 0,
  `stat_tested_tests` int(11) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `skills`
--

CREATE TABLE `skills` (
  `sname_id` int(11) NOT NULL,
  `sname_cat_id` int(11) NOT NULL,
  `sname_name` varchar(255) NOT NULL,
  `sname_identifier` varchar(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `skill_categories`
--

CREATE TABLE `skill_categories` (
  `scat_id` int(11) NOT NULL,
  `scat_name` varchar(255) NOT NULL,
  `scat_identifier` varchar(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `tds_history`
--

CREATE TABLE `tds_history` (
  `tds_id` int(255) NOT NULL,
  `tds_user_id` int(255) DEFAULT NULL,
  `tds_fy` varchar(255) DEFAULT NULL,
  `tds_amount` double DEFAULT NULL,
  `tds_added_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `tds_updated_date` timestamp NULL DEFAULT NULL ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `testing_time_sheet`
--

CREATE TABLE `testing_time_sheet` (
  `tts_id` int(50) NOT NULL,
  `tts_build_id` int(50) NOT NULL,
  `tts_tester_id` int(50) NOT NULL,
  `tts_date` date NOT NULL,
  `tts_total_time` time NOT NULL,
  `tts_add_time` timestamp NOT NULL DEFAULT current_timestamp(),
  `tts_approved_time` time DEFAULT NULL,
  `tts_approved_by` int(50) DEFAULT NULL,
  `tts_upd_by` int(50) NOT NULL,
  `tts_upd_time` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `test_case`
--

CREATE TABLE `test_case` (
  `case_id` int(11) NOT NULL,
  `testCaseId` varchar(100) NOT NULL,
  `testCaseFeature` varchar(255) DEFAULT NULL,
  `testCaseDesc` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `testCaseSteps` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `expectedResult` varchar(1500) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `test_id` int(11) NOT NULL,
  `test_status` varchar(200) NOT NULL,
  `build_id` varchar(20) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `test_report`
--

CREATE TABLE `test_report` (
  `trep_id` int(11) NOT NULL,
  `trep_build_id` int(11) DEFAULT NULL,
  `trep_assign_test_id` int(11) DEFAULT NULL,
  `trep_case_id` varchar(50) DEFAULT NULL COMMENT 'uniq identification',
  `trep_desc` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `trep_steps` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `trep_result` varchar(50) DEFAULT NULL COMMENT 'pass fail blocked',
  `trep_defect_id` varchar(50) DEFAULT NULL COMMENT 'to be selected from - defect id column of defect report table',
  `trep_add_by` int(11) DEFAULT NULL,
  `trep_upd_by` int(11) DEFAULT NULL,
  `trep_add_date` timestamp NULL DEFAULT current_timestamp(),
  `trep_upd_date` timestamp NULL DEFAULT NULL,
  `test_devices` varchar(100) NOT NULL,
  `test_browsers` varchar(300) DEFAULT NULL,
  `test_case_id` int(11) DEFAULT NULL,
  `trep_proof` varchar(50) DEFAULT NULL,
  `other` varchar(1500) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `test_review`
--

CREATE TABLE `test_review` (
  `rvw_id` int(11) NOT NULL,
  `rvw_build_id` int(11) DEFAULT NULL,
  `rvw_summary` longtext DEFAULT NULL,
  `rvw_desc` longtext DEFAULT NULL,
  `rvw_val` int(11) DEFAULT NULL,
  `rvw_add_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `rvw_add_by` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `test_scenarios`
--

CREATE TABLE `test_scenarios` (
  `tsc_id` int(255) NOT NULL,
  `tsc_desc` varchar(255) NOT NULL,
  `tsc_steps` varchar(255) NOT NULL,
  `tsc_build_id` int(100) NOT NULL,
  `tsc_assigned_testers` int(100) NOT NULL,
  `tsc_add_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `tsc_upd_date` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `test_scenario_reports`
--

CREATE TABLE `test_scenario_reports` (
  `tsr_id` int(255) NOT NULL,
  `tsr_sc_id` int(255) NOT NULL,
  `tsr_build_id` int(255) NOT NULL,
  `tsr_desc` varchar(255) DEFAULT NULL,
  `tsr_link` varchar(255) NOT NULL,
  `tsr_other` varchar(255) DEFAULT NULL,
  `tsr_add_by` int(100) NOT NULL,
  `tsr_upd_by` int(100) NOT NULL,
  `tsr_add_date` timestamp NOT NULL DEFAULT current_timestamp(),
  `tsr_upd_date` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `test_status`
--

CREATE TABLE `test_status` (
  `ts_id` int(11) NOT NULL,
  `ts_name` varchar(50) DEFAULT NULL,
  `ts_desc` varchar(50) DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci COMMENT='no of status';

-- --------------------------------------------------------

--
-- Table structure for table `test_types`
--

CREATE TABLE `test_types` (
  `tt_id` int(11) NOT NULL,
  `tt_name` varchar(100) DEFAULT NULL,
  `tt_desc` varchar(200) DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `usr_id` int(11) NOT NULL,
  `usr_role_id` int(11) NOT NULL,
  `usr_username` varchar(50) NOT NULL,
  `usr_password` varchar(50) NOT NULL,
  `usr_email` varchar(50) NOT NULL,
  `usr_firstname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `usr_lastname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `usr_companyname` varchar(50) DEFAULT NULL,
  `usr_phone` varchar(50) DEFAULT NULL,
  `usr_add_date` timestamp NULL DEFAULT NULL,
  `usr_upd_date` timestamp NULL DEFAULT NULL ON UPDATE current_timestamp(),
  `usr_add_by` int(11) DEFAULT NULL,
  `usr_upd_by` int(11) DEFAULT NULL,
  `usr_active` enum('active','inactive') CHARACTER SET latin1 COLLATE latin1_spanish_ci NOT NULL DEFAULT 'inactive',
  `usr_silent_mode` enum('active','inactive') NOT NULL DEFAULT 'active',
  `usr_country` varchar(50) NOT NULL,
  `usr_activation_code` longtext NOT NULL,
  `usr_profile_pic` varchar(500) NOT NULL DEFAULT '',
  `usr_skill_set` varchar(255) DEFAULT NULL,
  `usr_account_balance` double DEFAULT 0,
  `usr_looking_for` varchar(255) DEFAULT NULL,
  `usr_exp_years` int(11) DEFAULT NULL,
  `usr_current_orgnisation` int(11) DEFAULT NULL,
  `app_token` varchar(255) NOT NULL,
  `usr_cont_info` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `country_flag` varchar(30) DEFAULT NULL,
  `usr_city` varchar(200) DEFAULT NULL,
  `usr_apple` varchar(50) DEFAULT NULL,
  `usr_skype` varchar(50) DEFAULT NULL,
  `usr_linkedin` varchar(100) DEFAULT NULL,
  `usr_gender` varchar(10) DEFAULT NULL,
  `usr_age` varchar(5) DEFAULT NULL,
  `usr_desig` varchar(50) DEFAULT NULL,
  `usr_lang` varchar(50) DEFAULT NULL,
  `export` varchar(100) DEFAULT NULL,
  `jira_username` varchar(100) DEFAULT NULL,
  `jira_password` varchar(100) DEFAULT NULL,
  `jira_url` varchar(100) DEFAULT NULL,
  `rating` varchar(20) DEFAULT NULL,
  `usr_last_login` timestamp NULL DEFAULT NULL,
  `activity_status` enum('active','inactive') NOT NULL DEFAULT 'inactive',
  `usr_expert_badge` varchar(255) NOT NULL,
  `usr_agreement_file` varchar(255) DEFAULT NULL,
  `usr_agreement_verification` enum('verified','rejected') DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_browsers`
--

CREATE TABLE `user_browsers` (
  `user_browsers_id` int(11) NOT NULL,
  `os_id` int(11) NOT NULL,
  `browser_id` int(11) NOT NULL,
  `browser_version_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `created_by` int(11) NOT NULL,
  `created_date` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `deleted_date` timestamp NULL DEFAULT NULL,
  `browser_version` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_invitation`
--

CREATE TABLE `user_invitation` (
  `invite_id` int(11) NOT NULL,
  `invite_created_by` int(11) NOT NULL,
  `invite_org_id` int(11) NOT NULL,
  `invite_email` varchar(255) NOT NULL,
  `invite_role` int(11) NOT NULL,
  `invite_passcode` varchar(55) NOT NULL,
  `invite_datetime` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `invite_accepted` enum('yes','no') NOT NULL DEFAULT 'no'
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_organisation_map`
--

CREATE TABLE `user_organisation_map` (
  `uom_id` int(11) NOT NULL,
  `uom_user_id` int(11) NOT NULL,
  `uom_org_id` int(11) NOT NULL,
  `uom_role_id` int(11) NOT NULL,
  `uom_added_by` int(11) DEFAULT NULL,
  `uom_creation_date` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `uom_status` enum('active','inactive') NOT NULL DEFAULT 'inactive'
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `active_plans`
--
ALTER TABLE `active_plans`
  ADD PRIMARY KEY (`act_pid`);

--
-- Indexes for table `announcements`
--
ALTER TABLE `announcements`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `applied_tests`
--
ALTER TABLE `applied_tests`
  ADD PRIMARY KEY (`apt_id`);

--
-- Indexes for table `app_types`
--
ALTER TABLE `app_types`
  ADD PRIMARY KEY (`at_id`);

--
-- Indexes for table `assigned_tests`
--
ALTER TABLE `assigned_tests`
  ADD PRIMARY KEY (`ast_id`),
  ADD KEY `ast_build_id` (`ast_build_id`,`ast_tester_id`);

--
-- Indexes for table `assign_testCase`
--
ALTER TABLE `assign_testCase`
  ADD PRIMARY KEY (`Sno`);

--
-- Indexes for table `attachments`
--
ALTER TABLE `attachments`
  ADD PRIMARY KEY (`attach_id`),
  ADD KEY `attach_bugs_report_id` (`attach_bugs_report_id`);

--
-- Indexes for table `automation_modules`
--
ALTER TABLE `automation_modules`
  ADD PRIMARY KEY (`tc_id`);

--
-- Indexes for table `automation_reports`
--
ALTER TABLE `automation_reports`
  ADD PRIMARY KEY (`ID`);

--
-- Indexes for table `base_country`
--
ALTER TABLE `base_country`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `browsers`
--
ALTER TABLE `browsers`
  ADD PRIMARY KEY (`brw_id`);

--
-- Indexes for table `browser_versions`
--
ALTER TABLE `browser_versions`
  ADD PRIMARY KEY (`version_id`);

--
-- Indexes for table `bugs_report`
--
ALTER TABLE `bugs_report`
  ADD PRIMARY KEY (`bug_id`),
  ADD KEY `bug_type_id` (`bug_type_id`),
  ADD KEY `bug_build_id` (`bug_build_id`),
  ADD KEY `bug_project_id` (`bug_project_id`);

--
-- Indexes for table `bug_types`
--
ALTER TABLE `bug_types`
  ADD PRIMARY KEY (`bt_id`);

--
-- Indexes for table `builds`
--
ALTER TABLE `builds`
  ADD PRIMARY KEY (`build_id`),
  ADD KEY `project_id` (`project_id`),
  ADD KEY `build_cycle_type` (`build_cycle_type`);

--
-- Indexes for table `build_reports`
--
ALTER TABLE `build_reports`
  ADD PRIMARY KEY (`brep_id`);

--
-- Indexes for table `ci_sessions`
--
ALTER TABLE `ci_sessions`
  ADD KEY `ci_sessions_timestamp` (`timestamp`);

--
-- Indexes for table `comments_monitor`
--
ALTER TABLE `comments_monitor`
  ADD PRIMARY KEY (`monitor_id`),
  ADD KEY `bug_id` (`bug_id`),
  ADD KEY `comments_id` (`comments_id`),
  ADD KEY `written_to` (`written_to`),
  ADD KEY `written_by` (`written_by`);

--
-- Indexes for table `contests`
--
ALTER TABLE `contests`
  ADD PRIMARY KEY (`contest_id`);

--
-- Indexes for table `contest_answers`
--
ALTER TABLE `contest_answers`
  ADD PRIMARY KEY (`answer_id`);

--
-- Indexes for table `contest_feedback`
--
ALTER TABLE `contest_feedback`
  ADD PRIMARY KEY (`feedback_id`);

--
-- Indexes for table `contest_participant`
--
ALTER TABLE `contest_participant`
  ADD PRIMARY KEY (`participant_id`);

--
-- Indexes for table `contest_question`
--
ALTER TABLE `contest_question`
  ADD PRIMARY KEY (`question_id`);

--
-- Indexes for table `contest_tasks`
--
ALTER TABLE `contest_tasks`
  ADD PRIMARY KEY (`task_id`);

--
-- Indexes for table `cust_bug_answers`
--
ALTER TABLE `cust_bug_answers`
  ADD PRIMARY KEY (`cbfa_id`);

--
-- Indexes for table `cust_bug_fields`
--
ALTER TABLE `cust_bug_fields`
  ADD PRIMARY KEY (`cbf_id`);

--
-- Indexes for table `cust_feedback_answers`
--
ALTER TABLE `cust_feedback_answers`
  ADD PRIMARY KEY (`cffa_id`);

--
-- Indexes for table `cust_feedback_fields`
--
ALTER TABLE `cust_feedback_fields`
  ADD PRIMARY KEY (`cff_id`);

--
-- Indexes for table `defect_comments`
--
ALTER TABLE `defect_comments`
  ADD PRIMARY KEY (`comments_id`),
  ADD KEY `comments_build_id` (`comments_build_id`),
  ADD KEY `comments_bug_id` (`comments_bug_id`),
  ADD KEY `comments_done_by` (`comments_done_by`);

--
-- Indexes for table `devices`
--
ALTER TABLE `devices`
  ADD PRIMARY KEY (`dvc_id`),
  ADD KEY `dvc_mob_os_ver_id` (`dvc_mob_os_ver_id`),
  ADD KEY `dvc_manufacturer` (`dvc_manufacturer`);

--
-- Indexes for table `documents`
--
ALTER TABLE `documents`
  ADD PRIMARY KEY (`doc_id`);

--
-- Indexes for table `marketing`
--
ALTER TABLE `marketing`
  ADD PRIMARY KEY (`Sno`);

--
-- Indexes for table `message`
--
ALTER TABLE `message`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `message_recipient`
--
ALTER TABLE `message_recipient`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `mobile_brands`
--
ALTER TABLE `mobile_brands`
  ADD PRIMARY KEY (`mbr_id`),
  ADD UNIQUE KEY `mbr_name` (`mbr_name`);

--
-- Indexes for table `mobile_os_type`
--
ALTER TABLE `mobile_os_type`
  ADD PRIMARY KEY (`ost_id`),
  ADD UNIQUE KEY `ost_name` (`ost_name`);

--
-- Indexes for table `mobile_os_version`
--
ALTER TABLE `mobile_os_version`
  ADD PRIMARY KEY (`mov_id`),
  ADD UNIQUE KEY `mov_name` (`mov_name`),
  ADD KEY `mov_type_id` (`mov_type_id`);

--
-- Indexes for table `network_providers`
--
ALTER TABLE `network_providers`
  ADD PRIMARY KEY (`network_id`);

--
-- Indexes for table `notification`
--
ALTER TABLE `notification`
  ADD PRIMARY KEY (`Sno`);

--
-- Indexes for table `organisation`
--
ALTER TABLE `organisation`
  ADD PRIMARY KEY (`org_id`),
  ADD KEY `org_created_by` (`org_created_by`);

--
-- Indexes for table `os`
--
ALTER TABLE `os`
  ADD PRIMARY KEY (`os_id`);

--
-- Indexes for table `os_versions`
--
ALTER TABLE `os_versions`
  ADD PRIMARY KEY (`os_id`);

--
-- Indexes for table `payment_acc_details`
--
ALTER TABLE `payment_acc_details`
  ADD PRIMARY KEY (`pmt_id`),
  ADD UNIQUE KEY `pmt_user_id` (`pmt_user_id`),
  ADD KEY `pmt_country` (`pmt_country`,`pmt_status`);

--
-- Indexes for table `payment_history`
--
ALTER TABLE `payment_history`
  ADD PRIMARY KEY (`pmt_id`),
  ADD KEY `pmt_user_id` (`pmt_user_id`),
  ADD KEY `pmt_status` (`pmt_status`),
  ADD KEY `pmt_type` (`pmt_type`);

--
-- Indexes for table `permissions`
--
ALTER TABLE `permissions`
  ADD PRIMARY KEY (`per_id`);

--
-- Indexes for table `pricing_models`
--
ALTER TABLE `pricing_models`
  ADD PRIMARY KEY (`pm_id`);

--
-- Indexes for table `projects`
--
ALTER TABLE `projects`
  ADD PRIMARY KEY (`project_id`),
  ADD KEY `project_cycle_type` (`project_cycle_type`);

--
-- Indexes for table `resources`
--
ALTER TABLE `resources`
  ADD PRIMARY KEY (`res_id`);

--
-- Indexes for table `roles`
--
ALTER TABLE `roles`
  ADD PRIMARY KEY (`rol_id`);

--
-- Indexes for table `site_settings`
--
ALTER TABLE `site_settings`
  ADD PRIMARY KEY (`id`),
  ADD KEY `key_name` (`key_name`);

--
-- Indexes for table `site_statistics`
--
ALTER TABLE `site_statistics`
  ADD PRIMARY KEY (`stat_id`),
  ADD UNIQUE KEY `stat_date` (`stat_date`),
  ADD KEY `stat_logins` (`stat_logins`),
  ADD KEY `stat_new_test` (`stat_new_test`),
  ADD KEY `stat_tested_tests` (`stat_tested_tests`);

--
-- Indexes for table `skills`
--
ALTER TABLE `skills`
  ADD PRIMARY KEY (`sname_id`),
  ADD UNIQUE KEY `sname_identifier` (`sname_identifier`),
  ADD KEY `sname_cat_id` (`sname_cat_id`);

--
-- Indexes for table `skill_categories`
--
ALTER TABLE `skill_categories`
  ADD PRIMARY KEY (`scat_id`),
  ADD UNIQUE KEY `scat_identifier_2` (`scat_identifier`),
  ADD KEY `scat_identifier` (`scat_identifier`);

--
-- Indexes for table `tds_history`
--
ALTER TABLE `tds_history`
  ADD PRIMARY KEY (`tds_id`);

--
-- Indexes for table `testing_time_sheet`
--
ALTER TABLE `testing_time_sheet`
  ADD PRIMARY KEY (`tts_id`);

--
-- Indexes for table `test_case`
--
ALTER TABLE `test_case`
  ADD PRIMARY KEY (`case_id`),
  ADD KEY `test_id` (`test_id`);

--
-- Indexes for table `test_report`
--
ALTER TABLE `test_report`
  ADD PRIMARY KEY (`trep_id`),
  ADD KEY `test_case_id` (`test_case_id`);

--
-- Indexes for table `test_review`
--
ALTER TABLE `test_review`
  ADD PRIMARY KEY (`rvw_id`),
  ADD KEY `rvw_test_id` (`rvw_build_id`),
  ADD KEY `rvw_val` (`rvw_val`);

--
-- Indexes for table `test_scenarios`
--
ALTER TABLE `test_scenarios`
  ADD PRIMARY KEY (`tsc_id`);

--
-- Indexes for table `test_scenario_reports`
--
ALTER TABLE `test_scenario_reports`
  ADD PRIMARY KEY (`tsr_id`);

--
-- Indexes for table `test_status`
--
ALTER TABLE `test_status`
  ADD PRIMARY KEY (`ts_id`);

--
-- Indexes for table `test_types`
--
ALTER TABLE `test_types`
  ADD PRIMARY KEY (`tt_id`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`usr_id`),
  ADD KEY `usr_skill_set` (`usr_skill_set`,`usr_account_balance`),
  ADD KEY `usr_current_orgnisation` (`usr_current_orgnisation`);

--
-- Indexes for table `user_browsers`
--
ALTER TABLE `user_browsers`
  ADD PRIMARY KEY (`user_browsers_id`),
  ADD KEY `user_id` (`user_id`);

--
-- Indexes for table `user_invitation`
--
ALTER TABLE `user_invitation`
  ADD PRIMARY KEY (`invite_id`),
  ADD KEY `invite_created_by` (`invite_created_by`),
  ADD KEY `invite_email` (`invite_email`),
  ADD KEY `invite_role` (`invite_role`),
  ADD KEY `invite_passcode` (`invite_passcode`),
  ADD KEY `invite_datetime` (`invite_datetime`),
  ADD KEY `invite_accepted` (`invite_accepted`),
  ADD KEY `invite_org_id` (`invite_org_id`);

--
-- Indexes for table `user_organisation_map`
--
ALTER TABLE `user_organisation_map`
  ADD PRIMARY KEY (`uom_id`),
  ADD KEY `uom_user_id` (`uom_user_id`),
  ADD KEY `uom_org_id` (`uom_org_id`),
  ADD KEY `uom_role_id` (`uom_role_id`),
  ADD KEY `uom_creation_date` (`uom_creation_date`),
  ADD KEY `uom_added_by` (`uom_added_by`),
  ADD KEY `uom_status` (`uom_status`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `active_plans`
--
ALTER TABLE `active_plans`
  MODIFY `act_pid` int(20) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `announcements`
--
ALTER TABLE `announcements`
  MODIFY `id` int(200) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `applied_tests`
--
ALTER TABLE `applied_tests`
  MODIFY `apt_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `app_types`
--
ALTER TABLE `app_types`
  MODIFY `at_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `assigned_tests`
--
ALTER TABLE `assigned_tests`
  MODIFY `ast_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `assign_testCase`
--
ALTER TABLE `assign_testCase`
  MODIFY `Sno` int(20) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `attachments`
--
ALTER TABLE `attachments`
  MODIFY `attach_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `automation_modules`
--
ALTER TABLE `automation_modules`
  MODIFY `tc_id` int(100) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `automation_reports`
--
ALTER TABLE `automation_reports`
  MODIFY `ID` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `browsers`
--
ALTER TABLE `browsers`
  MODIFY `brw_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `browser_versions`
--
ALTER TABLE `browser_versions`
  MODIFY `version_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `bugs_report`
--
ALTER TABLE `bugs_report`
  MODIFY `bug_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `bug_types`
--
ALTER TABLE `bug_types`
  MODIFY `bt_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `builds`
--
ALTER TABLE `builds`
  MODIFY `build_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `build_reports`
--
ALTER TABLE `build_reports`
  MODIFY `brep_id` int(100) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `comments_monitor`
--
ALTER TABLE `comments_monitor`
  MODIFY `monitor_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contests`
--
ALTER TABLE `contests`
  MODIFY `contest_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contest_answers`
--
ALTER TABLE `contest_answers`
  MODIFY `answer_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contest_feedback`
--
ALTER TABLE `contest_feedback`
  MODIFY `feedback_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contest_participant`
--
ALTER TABLE `contest_participant`
  MODIFY `participant_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contest_question`
--
ALTER TABLE `contest_question`
  MODIFY `question_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `contest_tasks`
--
ALTER TABLE `contest_tasks`
  MODIFY `task_id` int(50) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `cust_bug_answers`
--
ALTER TABLE `cust_bug_answers`
  MODIFY `cbfa_id` int(255) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `cust_bug_fields`
--
ALTER TABLE `cust_bug_fields`
  MODIFY `cbf_id` int(100) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `cust_feedback_answers`
--
ALTER TABLE `cust_feedback_answers`
  MODIFY `cffa_id` int(30) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `cust_feedback_fields`
--
ALTER TABLE `cust_feedback_fields`
  MODIFY `cff_id` int(30) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `defect_comments`
--
ALTER TABLE `defect_comments`
  MODIFY `comments_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `devices`
--
ALTER TABLE `devices`
  MODIFY `dvc_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `documents`
--
ALTER TABLE `documents`
  MODIFY `doc_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `marketing`
--
ALTER TABLE `marketing`
  MODIFY `Sno` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `message`
--
ALTER TABLE `message`
  MODIFY `id` int(200) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `message_recipient`
--
ALTER TABLE `message_recipient`
  MODIFY `id` int(200) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mobile_brands`
--
ALTER TABLE `mobile_brands`
  MODIFY `mbr_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mobile_os_type`
--
ALTER TABLE `mobile_os_type`
  MODIFY `ost_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mobile_os_version`
--
ALTER TABLE `mobile_os_version`
  MODIFY `mov_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `network_providers`
--
ALTER TABLE `network_providers`
  MODIFY `network_id` int(20) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `notification`
--
ALTER TABLE `notification`
  MODIFY `Sno` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `organisation`
--
ALTER TABLE `organisation`
  MODIFY `org_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `os`
--
ALTER TABLE `os`
  MODIFY `os_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `os_versions`
--
ALTER TABLE `os_versions`
  MODIFY `os_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `payment_acc_details`
--
ALTER TABLE `payment_acc_details`
  MODIFY `pmt_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `payment_history`
--
ALTER TABLE `payment_history`
  MODIFY `pmt_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `permissions`
--
ALTER TABLE `permissions`
  MODIFY `per_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `pricing_models`
--
ALTER TABLE `pricing_models`
  MODIFY `pm_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `projects`
--
ALTER TABLE `projects`
  MODIFY `project_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `resources`
--
ALTER TABLE `resources`
  MODIFY `res_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `roles`
--
ALTER TABLE `roles`
  MODIFY `rol_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `site_settings`
--
ALTER TABLE `site_settings`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `site_statistics`
--
ALTER TABLE `site_statistics`
  MODIFY `stat_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `skills`
--
ALTER TABLE `skills`
  MODIFY `sname_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `skill_categories`
--
ALTER TABLE `skill_categories`
  MODIFY `scat_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `tds_history`
--
ALTER TABLE `tds_history`
  MODIFY `tds_id` int(255) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `testing_time_sheet`
--
ALTER TABLE `testing_time_sheet`
  MODIFY `tts_id` int(50) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `test_case`
--
ALTER TABLE `test_case`
  MODIFY `case_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `test_report`
--
ALTER TABLE `test_report`
  MODIFY `trep_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `test_review`
--
ALTER TABLE `test_review`
  MODIFY `rvw_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `test_scenarios`
--
ALTER TABLE `test_scenarios`
  MODIFY `tsc_id` int(255) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `test_scenario_reports`
--
ALTER TABLE `test_scenario_reports`
  MODIFY `tsr_id` int(255) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `test_status`
--
ALTER TABLE `test_status`
  MODIFY `ts_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `test_types`
--
ALTER TABLE `test_types`
  MODIFY `tt_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `usr_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user_browsers`
--
ALTER TABLE `user_browsers`
  MODIFY `user_browsers_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user_invitation`
--
ALTER TABLE `user_invitation`
  MODIFY `invite_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user_organisation_map`
--
ALTER TABLE `user_organisation_map`
  MODIFY `uom_id` int(11) NOT NULL AUTO_INCREMENT;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
