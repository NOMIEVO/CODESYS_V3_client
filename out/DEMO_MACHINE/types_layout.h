/* 自动生成，请勿手改 —— 源: DEMO_MACHINE.Device.Application.xml (SymbolConfig 3.5.14.0) */
#ifndef CODESYS_LAYOUT_H
#define CODESYS_LAYOUT_H
#include <stdint.h>

/* 尺寸与对齐均由 CODESYS 对齐规则推算，并经数组跨度交叉校验。
 * 使用方式：按偏移从报文缓冲区里 memcpy，不要依赖编译器对结构体的布局。 */

/* T_ARRAY__0__100__OF_BOOL  (ARRAY [0..100] OF BOOL, 101 bytes, align 1) */
#define SZ_T_ARRAY__0__100__OF_BOOL              101
#define AL_T_ARRAY__0__100__OF_BOOL              1
#define EL_T_ARRAY__0__100__OF_BOOL              1

/* T_ARRAY__0__100__OF_INT  (ARRAY [0..100] OF INT, 202 bytes, align 2) */
#define SZ_T_ARRAY__0__100__OF_INT               202
#define AL_T_ARRAY__0__100__OF_INT               2
#define EL_T_ARRAY__0__100__OF_INT               2

/* T_ARRAY__0__20__OF_INT  (ARRAY [0..20] OF INT, 42 bytes, align 2) */
#define SZ_T_ARRAY__0__20__OF_INT                42
#define AL_T_ARRAY__0__20__OF_INT                2
#define EL_T_ARRAY__0__20__OF_INT                2

/* T_ARRAY__0__2__OF_BOOL  (ARRAY [0..2] OF BOOL, 3 bytes, align 1) */
#define SZ_T_ARRAY__0__2__OF_BOOL                3
#define AL_T_ARRAY__0__2__OF_BOOL                1
#define EL_T_ARRAY__0__2__OF_BOOL                1

/* T_ARRAY__0__7__OF_T_ST_AXIS_CONTROL  (ARRAY [0..7] OF ST_AXIS_CONTROL, 352 bytes, align 4) */
#define SZ_T_ARRAY__0__7__OF_T_ST_AXIS_CONTROL   352
#define AL_T_ARRAY__0__7__OF_T_ST_AXIS_CONTROL   4
#define EL_T_ARRAY__0__7__OF_T_ST_AXIS_CONTROL   44

/* T_ARRAY__0__7__OF_T_ST_AXIS_PARAM  (ARRAY [0..7] OF ST_AXIS_PARAM, 256 bytes, align 4) */
#define SZ_T_ARRAY__0__7__OF_T_ST_AXIS_PARAM     256
#define AL_T_ARRAY__0__7__OF_T_ST_AXIS_PARAM     4
#define EL_T_ARRAY__0__7__OF_T_ST_AXIS_PARAM     32

/* T_ARRAY__0__9__OF_REAL  (ARRAY [0..9] OF REAL, 40 bytes, align 4) */
#define SZ_T_ARRAY__0__9__OF_REAL                40
#define AL_T_ARRAY__0__9__OF_REAL                4
#define EL_T_ARRAY__0__9__OF_REAL                4

/* T_ARRAY__1__6__OF_DINT  (ARRAY [1..6] OF DINT, 24 bytes, align 4) */
#define SZ_T_ARRAY__1__6__OF_DINT                24
#define AL_T_ARRAY__1__6__OF_DINT                4
#define EL_T_ARRAY__1__6__OF_DINT                4

/* T_ARRAY__1__6__OF_T_ST_CELL  (ARRAY [1..6] OF ST_CELL, 72 bytes, align 4, LAYOUT UNVERIFIED) */
#define SZ_T_ARRAY__1__6__OF_T_ST_CELL           72
#define AL_T_ARRAY__1__6__OF_T_ST_CELL           4
#define EL_T_ARRAY__1__6__OF_T_ST_CELL           12

/* T_BOOL  (BOOL, 1 bytes, align 1) */
#define SZ_T_BOOL                                1
#define AL_T_BOOL                                1

/* T_DINT  (DINT, 4 bytes, align 4) */
#define SZ_T_DINT                                4
#define AL_T_DINT                                4

/* T_E_MODE  (E_MODE, 2 bytes, align 2) */
#define SZ_T_E_MODE                              2
#define AL_T_E_MODE                              2

/* T_E_PRODUCT_RESULT  (E_PRODUCT_RESULT, 2 bytes, align 2) */
#define SZ_T_E_PRODUCT_RESULT                    2
#define AL_T_E_PRODUCT_RESULT                    2

/* T_INT  (INT, 2 bytes, align 2) */
#define SZ_T_INT                                 2
#define AL_T_INT                                 2

/* T_LREAL  (LREAL, 8 bytes, align 8) */
#define SZ_T_LREAL                               8
#define AL_T_LREAL                               8

/* T_REAL  (REAL, 4 bytes, align 4) */
#define SZ_T_REAL                                4
#define AL_T_REAL                                4

/* T_ST_AXIS_CONTROL  (ST_AXIS_CONTROL, 44 bytes, align 4) */
#define SZ_T_ST_AXIS_CONTROL                     44
#define AL_T_ST_AXIS_CONTROL                     4
#define OFF_T_ST_AXIS_CONTROL_FSETPOSITION       0
#define SZ_T_ST_AXIS_CONTROL_FSETPOSITION        4
#define OFF_T_ST_AXIS_CONTROL_FACTPOSITION       4
#define SZ_T_ST_AXIS_CONTROL_FACTPOSITION        4
#define OFF_T_ST_AXIS_CONTROL_TSTATE             8
#define SZ_T_ST_AXIS_CONTROL_TSTATE              16
#define OFF_T_ST_AXIS_CONTROL_BENABLE            24
#define SZ_T_ST_AXIS_CONTROL_BENABLE             1
#define OFF_T_ST_AXIS_CONTROL_BENABLED           25
#define SZ_T_ST_AXIS_CONTROL_BENABLED            1
#define OFF_T_ST_AXIS_CONTROL_BLIMITPOS          26
#define SZ_T_ST_AXIS_CONTROL_BLIMITPOS           1
#define OFF_T_ST_AXIS_CONTROL_BLIMITNEG          27
#define SZ_T_ST_AXIS_CONTROL_BLIMITNEG           1
#define OFF_T_ST_AXIS_CONTROL_BJOGFWD            28
#define SZ_T_ST_AXIS_CONTROL_BJOGFWD             1
#define OFF_T_ST_AXIS_CONTROL_BJOGBWD            29
#define SZ_T_ST_AXIS_CONTROL_BJOGBWD             1
#define OFF_T_ST_AXIS_CONTROL_AABSSEL            30
#define SZ_T_ST_AXIS_CONTROL_AABSSEL             3
#define OFF_T_ST_AXIS_CONTROL_FTARGETVEL         36
#define SZ_T_ST_AXIS_CONTROL_FTARGETVEL          4
#define OFF_T_ST_AXIS_CONTROL_DIERRORCODE        40
#define SZ_T_ST_AXIS_CONTROL_DIERRORCODE         4

/* T_ST_AXIS_PARAM  (ST_AXIS_PARAM, 32 bytes, align 4) */
#define SZ_T_ST_AXIS_PARAM                       32
#define AL_T_ST_AXIS_PARAM                       4
#define OFF_T_ST_AXIS_PARAM_FUPPERLIMIT          0
#define SZ_T_ST_AXIS_PARAM_FUPPERLIMIT           4
#define OFF_T_ST_AXIS_PARAM_FLOWERLIMIT          4
#define SZ_T_ST_AXIS_PARAM_FLOWERLIMIT           4
#define OFF_T_ST_AXIS_PARAM_FACC                 8
#define SZ_T_ST_AXIS_PARAM_FACC                  4
#define OFF_T_ST_AXIS_PARAM_FDEC                 12
#define SZ_T_ST_AXIS_PARAM_FDEC                  4
#define OFF_T_ST_AXIS_PARAM_FJERK                16
#define SZ_T_ST_AXIS_PARAM_FJERK                 4
#define OFF_T_ST_AXIS_PARAM_FJOGVEL              20
#define SZ_T_ST_AXIS_PARAM_FJOGVEL               4
#define OFF_T_ST_AXIS_PARAM_DIHOMEOFFSET         24
#define SZ_T_ST_AXIS_PARAM_DIHOMEOFFSET          4
#define OFF_T_ST_AXIS_PARAM_BINVERTDIR           28
#define SZ_T_ST_AXIS_PARAM_BINVERTDIR            1
#define OFF_T_ST_AXIS_PARAM_BSOFTLIMITEN         29
#define SZ_T_ST_AXIS_PARAM_BSOFTLIMITEN          1
#define OFF_T_ST_AXIS_PARAM_IMODE                30
#define SZ_T_ST_AXIS_PARAM_IMODE                 2

/* T_ST_AXIS_STATE  (ST_AXIS_STATE, 16 bytes, align 4) */
#define SZ_T_ST_AXIS_STATE                       16
#define AL_T_ST_AXIS_STATE                       4
#define OFF_T_ST_AXIS_STATE_BVALID               0
#define SZ_T_ST_AXIS_STATE_BVALID                1
#define OFF_T_ST_AXIS_STATE_BBUSY                1
#define SZ_T_ST_AXIS_STATE_BBUSY                 1
#define OFF_T_ST_AXIS_STATE_BERROR               2
#define SZ_T_ST_AXIS_STATE_BERROR                1
#define OFF_T_ST_AXIS_STATE_DIERRORID            4
#define SZ_T_ST_AXIS_STATE_DIERRORID             2
#define OFF_T_ST_AXIS_STATE_BDISABLED            6
#define SZ_T_ST_AXIS_STATE_BDISABLED             1
#define OFF_T_ST_AXIS_STATE_BSTOPPED             7
#define SZ_T_ST_AXIS_STATE_BSTOPPED              1
#define OFF_T_ST_AXIS_STATE_BMOVING              8
#define SZ_T_ST_AXIS_STATE_BMOVING               1
#define OFF_T_ST_AXIS_STATE_BHOMED               9
#define SZ_T_ST_AXIS_STATE_BHOMED                1
#define OFF_T_ST_AXIS_STATE_TELAPSED             12
#define SZ_T_ST_AXIS_STATE_TELAPSED              4

/* T_ST_CELL  (ST_CELL, 12 bytes, align 4, LAYOUT UNVERIFIED) */
#define SZ_T_ST_CELL                             12
#define AL_T_ST_CELL                             4
#define OFF_T_ST_CELL_URESULT                    0
#define SZ_T_ST_CELL_URESULT                     8
#define OFF_T_ST_CELL_BUSED                      8
#define SZ_T_ST_CELL_BUSED                       1

/* T_ST_PANEL_IN  (ST_PANEL_IN, 12 bytes, align 4) */
#define SZ_T_ST_PANEL_IN                         12
#define AL_T_ST_PANEL_IN                         4
#define OFF_T_ST_PANEL_IN_BSTART                 0
#define SZ_T_ST_PANEL_IN_BSTART                  1
#define OFF_T_ST_PANEL_IN_BSTOP                  1
#define SZ_T_ST_PANEL_IN_BSTOP                   1
#define OFF_T_ST_PANEL_IN_BRESET                 2
#define SZ_T_ST_PANEL_IN_BRESET                  1
#define OFF_T_ST_PANEL_IN_BESTOP                 3
#define SZ_T_ST_PANEL_IN_BESTOP                  1
#define OFF_T_ST_PANEL_IN_IMODESEL               4
#define SZ_T_ST_PANEL_IN_IMODESEL                2
#define OFF_T_ST_PANEL_IN_DICODED                8
#define SZ_T_ST_PANEL_IN_DICODED                 4

/* T_ST_PANEL_OUT  (ST_PANEL_OUT, 8 bytes, align 4) */
#define SZ_T_ST_PANEL_OUT                        8
#define AL_T_ST_PANEL_OUT                        4
#define OFF_T_ST_PANEL_OUT_BRUNNING              0
#define SZ_T_ST_PANEL_OUT_BRUNNING               1
#define OFF_T_ST_PANEL_OUT_BALARM                1
#define SZ_T_ST_PANEL_OUT_BALARM                 1
#define OFF_T_ST_PANEL_OUT_BREADY                2
#define SZ_T_ST_PANEL_OUT_BREADY                 1
#define OFF_T_ST_PANEL_OUT_BFAULT                3
#define SZ_T_ST_PANEL_OUT_BFAULT                 1
#define OFF_T_ST_PANEL_OUT_DICODE                4
#define SZ_T_ST_PANEL_OUT_DICODE                 4

/* T_TIME  (TIME, 4 bytes, align 4) */
#define SZ_T_TIME                                4
#define AL_T_TIME                                4

/* T_U_CELL_RESULT  (U_CELL_RESULT, 8 bytes, align 4, LAYOUT UNVERIFIED) */
#define SZ_T_U_CELL_RESULT                       8
#define AL_T_U_CELL_RESULT                       4
#define OFF_T_U_CELL_RESULT_ERESULT              0
#define SZ_T_U_CELL_RESULT_ERESULT               2
#define OFF_T_U_CELL_RESULT_DI                   4
#define SZ_T_U_CELL_RESULT_DI                    4

#endif /* CODESYS_LAYOUT_H */
